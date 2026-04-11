import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { PROJECT_STAGES } from "./projectStatuses";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Check, AlertTriangle, Lock, ChevronDown, ChevronUp } from "lucide-react";

function formatDuration(seconds) {
  if (seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(seconds / 3600);
  const remMins = Math.floor((seconds % 3600) / 60);
  const remSecs = seconds % 60;
  if (hours < 24) return `${hours}h ${remMins}m ${remSecs}s`;
  const days = Math.floor(seconds / 86400);
  const remHours = Math.floor((seconds % 86400) / 3600);
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function formatDurationCompact(seconds) {
  if (seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  const remHours = Math.floor((seconds % 86400) / 3600);
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function LiveTimer({ since, baseSeconds = 0, compact = false }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let iv = setInterval(() => setTick(t => t + 1), 1000);
    // Pause ticking when tab is hidden to avoid CPU waste and queued state updates.
    // The elapsed time is always computed from wall-clock (Date.now() - since) so
    // pausing the interval does not cause drift — it just skips unnecessary renders.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearInterval(iv);
        iv = null;
      } else {
        if (!iv) {
          setTick(t => t + 1); // immediate refresh on return
          iv = setInterval(() => setTick(t => t + 1), 1000);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const sinceMs = since ? new Date(fixTimestamp(since)).getTime() : Date.now();
  const elapsed = Math.floor(baseSeconds + Math.max(0, (Date.now() - sinceMs) / 1000));
  return <span>{compact ? formatDurationCompact(elapsed) : formatDuration(elapsed)}</span>;
}

function PulseDot() {
  return (
    <span className="absolute top-1 left-1.5 flex h-2.5 w-2.5">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-card opacity-75" />
      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-card opacity-95 shadow-sm" />
    </span>
  );
}

/** Safety: compute duration_seconds for a timer record, capped at 90d */
function computeSafeSeconds(timer) {
  if (!timer) return 0;
  if (timer.exit_time) {
    // Closed timer — use stored value, but sanity check
    const stored = timer.duration_seconds || 0;
    return Math.max(0, Math.min(stored, 90 * 24 * 3600));
  }
  // Open timer — compute live from entry_time
  const entry = timer.entry_time ? new Date(fixTimestamp(timer.entry_time)).getTime() : null;
  if (!entry) return 0;
  const diff = Math.floor((Date.now() - entry) / 1000);
  return Math.max(0, Math.min(diff, 90 * 24 * 3600));
}

/* ── Confirmation Dialog ──────────────────────────────────────────────── */
function ConfirmStageDialog({ open, onConfirm, onCancel, targetLabel, currentLabel }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl p-5 max-w-sm w-full mx-4 animate-in fade-in zoom-in-95 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-foreground mb-1">Advance Project Stage?</p>
        <p className="text-xs text-muted-foreground mb-4">
          Move from <strong>{currentLabel}</strong> to <strong>{targetLabel}</strong>?
          This will update the project status for all team members.
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-card hover:bg-muted transition-colors"
            onClick={onCancel}
            aria-label="Cancel stage change"
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-[#1a73e8] hover:bg-[#1558b0] text-white transition-colors"
            onClick={onConfirm}
            aria-label={`Confirm move to ${targetLabel}`}
          >
            Move to {targetLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StagePipeline({ project, onStatusChange, canEdit, allTasksDone, projectTasks }) {
  // Real-time subscription — triggers a re-render instantly on any timer change
  const [stageTimers, setStageTimers] = useState([]);
  const [timerKey, setTimerKey] = useState(0);

  // Confirmation dialog state for forward advancement
  const [confirmTarget, setConfirmTarget] = useState(null);

  // Compact mode for mobile
  const [expanded, setExpanded] = useState(false);

  // BUG FIX (subscription audit): Was fetching ALL ProjectStageTimers across all
  // projects via .list(), then filtering client-side. For a system with many projects
  // this is wasteful and creates a race condition where subscription events for other
  // projects cause unnecessary state churn. Now uses .filter() to fetch only this
  // project's timers server-side.
  useEffect(() => {
    let mounted = true;

    // Initial load — fetch only timers for this project
    api.entities.ProjectStageTimer.filter({ project_id: project.id }).then(timers => {
      if (!mounted) return;
      setStageTimers(timers || []);
    });

    // Live subscription
    const unsub = api.entities.ProjectStageTimer.subscribe((event) => {
      if (!mounted) return;
      setStageTimers(prev => {
        // Only care about timers for this project
        if (event.data?.project_id !== project.id && event.type !== 'delete') {
          // Check if we already have it and if it matches project
          const existing = prev.find(t => t.id === event.id);
          if (!existing) return prev;
        }
        if (event.type === 'create' && event.data?.project_id === project.id) {
          // Avoid duplicate adds
          if (prev.some(t => t.id === event.id)) return prev;
          return [...prev, event.data];
        }
        if (event.type === 'update') {
          return prev.map(t => t.id === event.id ? event.data : t);
        }
        if (event.type === 'delete') {
          return prev.filter(t => t.id !== event.id);
        }
        return prev;
      });
      setTimerKey(k => k + 1); // force re-render
    });

    return () => { mounted = false; unsub(); };
  }, [project.id]);

  // Fix orphaned timers (open timers for non-current stages) outside render path
  useEffect(() => {
    if (!stageTimers.length) return;
    const currentStageValue = project.status;
    stageTimers.forEach(t => {
      if (!t.exit_time && t.stage !== currentStageValue) {
        api.entities.ProjectStageTimer.update(t.id, {
          exit_time: t.updated_date || new Date().toISOString(),
        }).catch(() => {});
      }
    });
  }, [stageTimers, project.status]);

  // ── Optimistic session state ──────────────────────────────────────────────
  const sessionRef = useRef({
    status: project.status,
    history: {},   // stageValue -> { entryTime, closedSeconds }
    pendingSync: false,
  });
  const [renderKey, setRenderKey] = useState(0);
  const forceRender = useCallback(() => setRenderKey(k => k + 1), []);

  // Sync from DB when external status change arrives (not one we triggered)
  useEffect(() => {
    const s = sessionRef.current;
    if (!s.pendingSync && project.status !== s.status) {
      s.status = project.status;
      s.history = {};
      forceRender();
    }
    if (s.pendingSync && project.status === s.status) {
      s.pendingSync = false;
    }
  }, [project.status]);

  // ── Delivery guard: compute task readiness for "Delivered" stage ───────────
  const deliveryGuard = useMemo(() => {
    const tasks = projectTasks || [];
    const active = tasks.filter(t => !t.is_deleted && !t.is_archived);
    if (active.length === 0) return { ready: true, reason: null, completedCount: 0, totalCount: 0 };
    const completed = active.filter(t => t.is_completed);
    const incomplete = active.length - completed.length;
    if (incomplete > 0) {
      return {
        ready: false,
        reason: `${incomplete} of ${active.length} task${active.length > 1 ? 's' : ''} still incomplete`,
        completedCount: completed.length,
        totalCount: active.length,
      };
    }
    return { ready: true, reason: null, completedCount: completed.length, totalCount: active.length };
  }, [projectTasks]);

  const handleStageClick = useCallback((stageValue) => {
    if (!canEdit) return;
    const s = sessionRef.current;
    if (s.status === stageValue) return;
    // in_revision is managed automatically by the revision system — block manual entry
    if (stageValue === 'in_revision') return;

    // Delivery guard: block advancing to delivered if tasks are incomplete
    if (stageValue === 'delivered' && !deliveryGuard.ready) {
      toast.error(deliveryGuard.reason || 'Cannot deliver: tasks are incomplete');
      return;
    }

    // Show confirmation dialog for forward advancement
    const stageValues = PROJECT_STAGES.map(st => st.value);
    const currentIdx = stageValues.indexOf(s.status);
    const targetIdx = stageValues.indexOf(stageValue);
    if (targetIdx > currentIdx) {
      setConfirmTarget(stageValue);
      return;
    }

    // Backward moves are handled by ProjectDetails (pendingBackwardStage dialog).
    // Do NOT optimistically update session state here — let ProjectDetails confirm
    // first, then the project.status prop change will sync back via useEffect.
    onStatusChange(stageValue);
  }, [canEdit, deliveryGuard, onStatusChange]);

  const executeStageChange = useCallback((stageValue) => {
    const s = sessionRef.current;
    const now = new Date().toISOString();
    const nowMs = Date.now();

    // Close the current stage in session history
    const prev = s.history[s.status];
    if (prev?.entryTime) {
      const elapsed = Math.floor((nowMs - new Date(prev.entryTime).getTime()) / 1000);
      s.history[s.status] = {
        entryTime: null,
        closedSeconds: (prev.closedSeconds || 0) + elapsed,
      };
    } else {
      s.history[s.status] = { entryTime: null, closedSeconds: s.history[s.status]?.closedSeconds || 0 };
    }

    // Open the new stage optimistically
    s.history[stageValue] = {
      entryTime: now,
      closedSeconds: s.history[stageValue]?.closedSeconds || 0,
    };

    s.status = stageValue;
    s.pendingSync = true;

    forceRender();
    onStatusChange(stageValue);
  }, [onStatusChange, forceRender]);

  const handleConfirm = useCallback(() => {
    if (confirmTarget) {
      executeStageChange(confirmTarget);
      setConfirmTarget(null);
    }
  }, [confirmTarget, executeStageChange]);

  // ── Derive time info ──────────────────────────────────────────────────────
  const s = sessionRef.current;
  const currentIndex = PROJECT_STAGES.findIndex(st => st.value === s.status);

  const isArchived = project?.is_archived === true;
  const isCancelled = project?.outcome === 'lost';

  // Close orphaned timers once via useEffect (not during render) to avoid
  // spamming the API on every re-render. Track which IDs we've already patched.
  const closedOrphanIdsRef = useRef(new Set());
  useEffect(() => {
    stageTimers.forEach(t => {
      if (!t.exit_time && t.stage !== s.status && !closedOrphanIdsRef.current.has(t.id)) {
        closedOrphanIdsRef.current.add(t.id);
        api.entities.ProjectStageTimer.update(t.id, {
          exit_time: t.updated_date || new Date().toISOString(),
        }).catch(() => toast.error('Failed to close orphaned stage timer — stage time may be inaccurate'));
      }
    });
  }, [stageTimers, s.status]);

  function getStageTimeInfo(stage, index) {
    const isCurrent = index === currentIndex;
    const isFuture = index > currentIndex;
    const dbTimers = stageTimers.filter(t => t.stage === stage.value);
    const session = s.history[stage.value];

    if (isFuture && dbTimers.length === 0 && !session) return null;

    // Safety: for non-current stages, enforce all timers have exit_time
    // Any open timer for a non-current stage is a bug — treat it as if it ended now
    // Note: DB fix is deferred to useEffect below to avoid side effects during render
    const safeDbTimers = dbTimers.map(t => {
      if (!t.exit_time && !isCurrent) {
        // Orphaned open timer — patched in useEffect above, treat as closed for display
        return {
          ...t,
          exit_time: t.updated_date || new Date().toISOString(),
          duration_seconds: computeSafeSeconds(t),
          _orphaned: true,
        };
      }
      return t;
    });

    // DB totals: sum all closed timers
    let dbClosedSeconds = 0;
    safeDbTimers.forEach(t => {
      if (t.exit_time) dbClosedSeconds += (t.duration_seconds || 0);
    });
    const openDbTimer = isCurrent ? safeDbTimers.find(t => !t.exit_time) : null;
    const visitCount = safeDbTimers.length || (session ? 1 : 0);

    if (isCurrent) {
      const entryTime = session?.entryTime || openDbTimer?.entry_time || null;
      const baseSeconds = dbClosedSeconds + (openDbTimer?.duration_seconds || 0);
      return {
        entryTime,
        exitTime: null,
        durationSeconds: baseSeconds,
        isCurrentStage: true,
        visitCount: Math.max(visitCount, 1),
        isReEntry: Math.max(visitCount, 1) > 1,
        dbTimers: safeDbTimers,
      };
    }

    if (safeDbTimers.length === 0 && !session) return null;

    const sessionExtra = (session && !session.entryTime) ? (session.closedSeconds || 0) : 0;
    let totalSeconds = dbClosedSeconds + sessionExtra;

    const sortedDb = [...safeDbTimers].sort((a, b) => new Date(fixTimestamp(b.entry_time)) - new Date(fixTimestamp(a.entry_time)));
    const lastTimer = sortedDb[0];

    return {
      entryTime: lastTimer?.entry_time || null,
      exitTime: lastTimer?.exit_time || null,
      durationSeconds: totalSeconds,
      isCurrentStage: false,
      visitCount,
      isReEntry: visitCount > 1,
      dbTimers: safeDbTimers,
    };
  }

  // ── Compact mode: determine which stages to show on mobile ────────────────
  const visibleStagesCompact = useMemo(() => {
    if (expanded) return PROJECT_STAGES.map((_, i) => i);
    // Show: first completed that has time, current stage, next stage
    const visible = new Set();
    // Always show current
    if (currentIndex >= 0) visible.add(currentIndex);
    // Previous stage (most recent completed)
    if (currentIndex > 0) visible.add(currentIndex - 1);
    // Next stage
    if (currentIndex < PROJECT_STAGES.length - 1) visible.add(currentIndex + 1);
    return [...visible].sort((a, b) => a - b);
  }, [currentIndex, expanded]);

  const hiddenCount = PROJECT_STAGES.length - visibleStagesCompact.length;

  // ── Current stage label for header ────────────────────────────────────────
  const currentStageLabel = PROJECT_STAGES[currentIndex]?.label || project.status;
  const currentTimeInfo = currentIndex >= 0 ? getStageTimeInfo(PROJECT_STAGES[currentIndex], currentIndex) : null;

  return (
    <TooltipProvider delayDuration={100}>
      {/* Confirmation dialog for forward advancement */}
      <ConfirmStageDialog
        open={!!confirmTarget}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmTarget(null)}
        targetLabel={PROJECT_STAGES.find(st => st.value === confirmTarget)?.label || confirmTarget}
        currentLabel={PROJECT_STAGES[currentIndex]?.label || s.status}
      />

      <div className={cn(
        "rounded-lg border bg-card shadow-sm",
        isArchived && "border-muted opacity-70",
        isCancelled && "border-red-200 dark:border-red-900/40"
      )}>
        {/* Header: stage label + live timer + mobile compact toggle */}
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Pipeline</p>
            {(isArchived || isCancelled) && (
              <span className={cn(
                "text-[9px] font-bold uppercase px-1.5 py-0.5 rounded",
                isArchived ? "bg-muted text-muted-foreground" : "bg-red-100 dark:bg-red-950/30 text-red-600 dark:text-red-400"
              )}>
                {isArchived ? "Archived" : "Cancelled"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Current stage summary with live timer */}
            {currentTimeInfo?.entryTime && (
              <span className="text-[10px] text-muted-foreground font-medium hidden sm:inline-flex items-center gap-1">
                In <span className="font-semibold text-foreground">{currentStageLabel}</span> for{" "}
                <span className="font-mono tabular-nums text-foreground">
                  <LiveTimer since={currentTimeInfo.entryTime} baseSeconds={currentTimeInfo.durationSeconds} compact={true} />
                </span>
              </span>
            )}
            {/* Mobile expand/collapse toggle */}
            {hiddenCount > 0 && (
              <button
                onClick={() => setExpanded(v => !v)}
                className="sm:hidden flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded border border-transparent hover:border-border"
                aria-label={expanded ? 'Collapse pipeline stages' : `Show ${hiddenCount} more pipeline stages`}
                title={expanded ? 'Show fewer stages' : `Show all ${PROJECT_STAGES.length} stages`}
              >
                {expanded ? (
                  <>Collapse <ChevronUp className="h-3 w-3" /></>
                ) : (
                  <>{hiddenCount} more <ChevronDown className="h-3 w-3" /></>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Stage chips */}
        <div className="overflow-x-auto px-3 pb-3">
          <div className="flex min-w-max gap-0">
            {PROJECT_STAGES.map((stage, index) => {
              const isCompleted = index < currentIndex;
              const isCurrent = index === currentIndex;
              const isFuture = index > currentIndex;
              const timeInfo = getStageTimeInfo(stage, index);
              const isFirst = index === 0;
              const isLast = index === PROJECT_STAGES.length - 1;
              const isDeliveredStage = stage.value === 'delivered';
              const isRevisionStage = stage.value === 'in_revision';

              // Mobile compact: hide stages not in visible set
              const isVisibleCompact = visibleStagesCompact.includes(index);

              // Delivery guard badge: show warning on Delivered stage if tasks incomplete
              const showDeliveryWarning = isDeliveredStage && isFuture && !deliveryGuard.ready && deliveryGuard.totalCount > 0;

              const bgClass = isArchived
                ? "bg-muted text-muted-foreground"
                : isCancelled
                ? isCurrent ? "bg-red-500 text-white" : isCompleted ? "bg-red-200 text-red-800 dark:bg-red-900/30 dark:text-red-300" : "bg-muted text-muted-foreground"
                : isCurrent
                ? "bg-[#1a73e8] text-white"
                : isCompleted
                ? "bg-[#34a853] text-white"
                : timeInfo
                ? "bg-[#c5cae9] text-[#3c4043]"
                : "bg-[#e8eaed] text-[#5f6368]";

              const hoverClass = canEdit && !isArchived
                ? isCurrent ? "hover:bg-[#1558b0]"
                : isCompleted ? "hover:bg-[#2d8f47]"
                : timeInfo ? "hover:bg-[#aab0e0]"
                : "hover:bg-[#dadce0]"
                : "";

              const clipPath = isFirst
                ? "polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%)"
                : isLast
                ? "polygon(10px 0, 100% 0, 100% 100%, 10px 100%, 0 50%)"
                : "polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%)";

              const stageButton = (
                <button
                  key={stage.value}
                  onClick={() => handleStageClick(stage.value)}
                  className={cn(
                    "relative flex flex-col items-center justify-center h-12 transition-all duration-200 select-none outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary",
                    isFirst ? "pl-4 pr-6 min-w-[90px]" : isLast ? "pl-6 pr-4 min-w-[90px]" : "px-5 min-w-[90px]",
                    bgClass, hoverClass,
                    canEdit && !isArchived ? "cursor-pointer active:scale-95" : "cursor-default opacity-90",
                    isCurrent && !isArchived && !isCancelled && "ring-2 ring-[#1a73e8]/30",
                    isFuture && !timeInfo && !isArchived && "opacity-60",
                    // Mobile compact visibility
                    !isVisibleCompact && "hidden sm:flex"
                  )}
                  style={{ clipPath, marginLeft: index === 0 ? 0 : "-2px" }}
                  disabled={!canEdit || isArchived}
                  aria-label={`${stage.label} - ${isCompleted ? "completed" : isCurrent ? "current" : "future"}${showDeliveryWarning ? " - tasks incomplete" : ""}`}
                >
                  {/* Active stage pulse indicator */}
                  {isCurrent && !isArchived && !isCancelled && <PulseDot />}

                  {/* Completed stage checkmark */}
                  {isCompleted && !isArchived && (
                    <span className="absolute top-0.5 left-1.5">
                      <Check className="h-3 w-3 text-white/80" strokeWidth={3} />
                    </span>
                  )}

                  {/* Re-entry visit count badge */}
                  {timeInfo?.isReEntry && (
                    <span className={cn(
                      "absolute top-0.5 right-1.5 text-[8px] font-bold rounded-full px-1.5 py-0.5 leading-tight shadow-sm",
                      isCurrent || isCompleted ? "bg-card/40 text-white backdrop-blur-sm" : "bg-[#3c4043]/30 text-[#3c4043]"
                    )} title={`Visited ${timeInfo.visitCount} times`}>
                      x{timeInfo.visitCount}
                    </span>
                  )}

                  {/* Delivery guard warning badge */}
                  {showDeliveryWarning && (
                    <span className="absolute -top-1 -right-1 z-10 flex items-center justify-center">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 drop-shadow-sm" />
                    </span>
                  )}

                  <span className="text-[10px] font-bold leading-tight text-center whitespace-nowrap opacity-95 tracking-wide">
                    {stage.label}
                  </span>

                  <span className="text-[11px] font-bold leading-tight mt-1 tabular-nums">
                    {isCurrent && timeInfo?.entryTime ? (
                      <LiveTimer since={timeInfo.entryTime} baseSeconds={timeInfo.durationSeconds} compact={false} />
                    ) : timeInfo ? (
                      formatDuration(timeInfo.durationSeconds)
                    ) : (
                      <span className="opacity-40 text-[10px]">--</span>
                    )}
                  </span>
                </button>
              );

              // Non-editable tooltip for locked stages
              if (!canEdit && isFuture) {
                return (
                  <Tooltip key={stage.value}>
                    <TooltipTrigger asChild>{stageButton}</TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs max-w-[200px]">
                      <div className="flex items-center gap-1.5">
                        <Lock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        <span>You need edit permissions to advance the project stage.</span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              }

              // Revision stage tooltip (always blocked for manual entry)
              if (isRevisionStage && isFuture) {
                return (
                  <Tooltip key={stage.value}>
                    <TooltipTrigger asChild>{stageButton}</TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs max-w-[220px]">
                      <span>In Revision is set automatically when a revision is created. It cannot be set manually.</span>
                    </TooltipContent>
                  </Tooltip>
                );
              }

              // Delivery guard tooltip on Delivered stage
              if (showDeliveryWarning) {
                return (
                  <Tooltip key={stage.value}>
                    <TooltipTrigger asChild>{stageButton}</TooltipTrigger>
                    <TooltipContent side="bottom" className="p-0 overflow-hidden shadow-xl border-0 w-64">
                      <div className="bg-[#202124] text-white rounded-lg overflow-hidden">
                        <div className="px-4 py-2.5 bg-amber-600 flex items-center gap-2">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          <p className="font-semibold text-sm">Not Ready to Deliver</p>
                        </div>
                        <div className="px-4 py-3 text-xs space-y-2">
                          <p className="text-white/80">{deliveryGuard.reason}</p>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-amber-500 rounded-full transition-all"
                                style={{ width: `${deliveryGuard.totalCount > 0 ? (deliveryGuard.completedCount / deliveryGuard.totalCount) * 100 : 0}%` }}
                              />
                            </div>
                            <span className="text-white/50 text-[10px] font-mono">
                              {deliveryGuard.completedCount}/{deliveryGuard.totalCount}
                            </span>
                          </div>
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              }

              // Future stages with no time info — no detailed tooltip needed
              if (!timeInfo && isFuture) return stageButton;

              const sortedVisits = timeInfo?.dbTimers
                ? [...timeInfo.dbTimers].sort((a, b) => new Date(fixTimestamp(a.entry_time)) - new Date(fixTimestamp(b.entry_time)))
                : [];

              return (
                <Tooltip key={stage.value}>
                  <TooltipTrigger asChild>{stageButton}</TooltipTrigger>
                  <TooltipContent side="bottom" className="p-0 overflow-hidden shadow-xl border-0 w-64">
                    <div className="bg-[#202124] text-white rounded-lg overflow-hidden">
                      <div className={cn(
                        "px-4 py-2.5 flex items-center justify-between",
                        isCurrent ? "bg-[#1a73e8]" : isCompleted ? "bg-[#34a853]" : "bg-[#5f6368]"
                      )}>
                        <p className="font-semibold text-sm">{stage.label}</p>
                        {isCurrent ? (
                          <span className="flex items-center gap-1 text-[10px] font-medium bg-card/20 rounded-full px-2 py-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-card animate-pulse" />
                            LIVE
                          </span>
                        ) : timeInfo ? (
                          <span className="text-[10px] font-medium bg-card/20 rounded-full px-2 py-0.5">
                            {timeInfo.visitCount}x visited
                          </span>
                        ) : null}
                      </div>

                      {timeInfo && (
                        <div className="px-4 py-3 space-y-3 text-xs">
                          {sortedVisits.length > 1 && (
                            <div className="space-y-1.5">
                              <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Visit History</p>
                              {sortedVisits.map((visit, i) => (
                                <div key={visit.id || i} className="flex items-center justify-between bg-card/5 rounded px-2 py-1">
                                  <div className="text-white/60">
                                    <span className="text-white/40 text-[10px]">#{i + 1} </span>
                                    <span>{new Date(fixTimestamp(visit.entry_time)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                     {visit.exit_time && (
                                       <span className="text-white/40"> &rarr; {new Date(fixTimestamp(visit.exit_time)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                     )}
                                    {!visit.exit_time && isCurrent && (
                                      <span className="text-blue-300"> &rarr; now</span>
                                    )}
                                  </div>
                                  <span className="font-mono font-bold text-white tabular-nums">
                                    {!visit.exit_time && isCurrent
                                      ? <LiveTimer since={visit.entry_time} baseSeconds={visit.duration_seconds || 0} />
                                      : formatDuration(visit.duration_seconds || 0)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          {sortedVisits.length === 1 && (
                            <div className="space-y-1.5 text-white/80">
                              <div className="flex justify-between">
                                <span className="text-white/50">Entered</span>
                                <span className="font-medium">{new Date(fixTimestamp(sortedVisits[0].entry_time)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                              </div>
                              {sortedVisits[0].exit_time ? (
                                <div className="flex justify-between">
                                  <span className="text-white/50">Exited</span>
                                  <span className="font-medium">{new Date(fixTimestamp(sortedVisits[0].exit_time)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                </div>
                              ) : isCurrent ? (
                                <div className="flex justify-between">
                                  <span className="text-white/50">Status</span>
                                  <span className="text-blue-300 font-medium">Still active</span>
                                </div>
                              ) : null}
                            </div>
                          )}

                          <div className="flex justify-between items-center pt-2 border-t border-white/10">
                            <span className="font-semibold text-white text-[11px]">
                              {isCurrent ? "Time in stage" : "Total duration"}
                            </span>
                            <span className="font-bold text-white font-mono tabular-nums text-sm">
                              {isCurrent && timeInfo.entryTime
                                ? <LiveTimer since={timeInfo.entryTime} baseSeconds={timeInfo.durationSeconds} />
                                : formatDuration(timeInfo.durationSeconds)}
                            </span>
                          </div>
                        </div>
                      )}

                      {!timeInfo && (
                        <div className="px-4 py-3 text-xs text-white/40 text-center">Not yet reached</div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* Mobile: Show All / Collapse toggle below pipeline */}
          {hiddenCount > 0 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="sm:hidden w-full mt-1.5 flex items-center justify-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1 rounded border border-dashed border-border/50 hover:border-border"
            >
              {expanded ? (
                <>Show less <ChevronUp className="h-3 w-3" /></>
              ) : (
                <>Show all {PROJECT_STAGES.length} stages <ChevronDown className="h-3 w-3" /></>
              )}
            </button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

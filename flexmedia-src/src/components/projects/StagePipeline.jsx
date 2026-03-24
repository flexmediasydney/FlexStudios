import React, { useState, useEffect, useRef, useCallback } from "react";
import { PROJECT_STAGES } from "./projectStatuses";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";

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
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
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

export default function StagePipeline({ project, onStatusChange, canEdit }) {
  // Real-time subscription — triggers a re-render instantly on any timer change
  const [stageTimers, setStageTimers] = useState([]);
  const [timerKey, setTimerKey] = useState(0);

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

  const handleStageClick = useCallback((stageValue) => {
    if (!canEdit) return;
    const s = sessionRef.current;
    if (s.status === stageValue) return;
    // in_revision is managed automatically by the revision system — block manual entry
    if (stageValue === 'in_revision') return;

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
  }, [canEdit, onStatusChange, forceRender]);

  // ── Derive time info ──────────────────────────────────────────────────────
  const s = sessionRef.current;
  const currentIndex = PROJECT_STAGES.findIndex(st => st.value === s.status);

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

  return (
    <TooltipProvider delayDuration={100}>
      <div className="overflow-x-auto rounded-lg border border-border bg-card p-3 shadow-sm">
        <p className="text-xs font-bold text-muted-foreground mb-3 uppercase tracking-wide">Project Stage Pipeline</p>
        <div className="flex min-w-max gap-0">
          {PROJECT_STAGES.map((stage, index) => {
            const isCompleted = index < currentIndex;
            const isCurrent = index === currentIndex;
            const isFuture = index > currentIndex;
            const timeInfo = getStageTimeInfo(stage, index);
            const isFirst = index === 0;
            const isLast = index === PROJECT_STAGES.length - 1;

            const bgClass = isCurrent
              ? "bg-[#1a73e8] text-white"
              : isCompleted
              ? "bg-[#34a853] text-white"
              : timeInfo
              ? "bg-[#c5cae9] text-[#3c4043]"
              : "bg-[#e8eaed] text-[#5f6368]";

            const hoverClass = canEdit
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
                  "relative flex flex-col items-center justify-center h-12 transition-all duration-200 select-none outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary active:scale-95",
                  isFirst ? "pl-4 pr-6 min-w-[90px]" : isLast ? "pl-6 pr-4 min-w-[90px]" : "px-5 min-w-[90px]",
                  bgClass, hoverClass,
                  canEdit ? "cursor-pointer" : "cursor-default opacity-90",
                  isCurrent && "ring-2 ring-[#1a73e8]/30"
                )}
                style={{ clipPath, marginLeft: index === 0 ? 0 : "-2px" }}
                disabled={!canEdit}
                aria-label={`${stage.label} - ${isCompleted ? "completed" : isCurrent ? "current" : "future"}`}
              >
                {isCurrent && <PulseDot />}

                {timeInfo?.isReEntry && (
                  <span className={cn(
                    "absolute top-0.5 right-1.5 text-[8px] font-bold rounded-full px-1.5 py-0.5 leading-tight shadow-sm",
                    isCurrent || isCompleted ? "bg-card/40 text-white backdrop-blur-sm" : "bg-[#3c4043]/30 text-[#3c4043]"
                  )} title={`Visited ${timeInfo.visitCount} times`}>
                    ×{timeInfo.visitCount}
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
                    <span className="opacity-40 text-[10px]">—</span>
                  )}
                </span>
              </button>
            );

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
                          {timeInfo.visitCount}× visited
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
                                     <span className="text-white/40"> → {new Date(fixTimestamp(visit.exit_time)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                   )}
                                  {!visit.exit_time && isCurrent && (
                                    <span className="text-blue-300"> → now</span>
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
                            {isCurrent ? "⏱ Time in stage" : "Total duration"}
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
      </div>
    </TooltipProvider>
  );
}
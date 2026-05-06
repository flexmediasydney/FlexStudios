// Compact, single-card project summary header.
//
// Replaces the existing 6-row stack on ProjectDetails:
//   - Title block (title + address + map pin + "Pinned" badge + health row)
//   - Right-aligned status pills (paid, partially delivered, edit, archive)
//   - Big chevron StagePipeline (~100px tall)
//   - Approval banner
//   - ProjectProgressBar card (Tasks)
//   - RequestsProgressBar card (Requests)
//
// All data and handlers stay the same — only the layout collapses to ~140px.
// Stage durations are computed from ProjectStageTimer with the same logic as
// StagePipeline (live timer for current stage, summed closed timers for past).
//
// Wired in ProjectDetails.jsx behind a `?compact=1` query param so you can
// toggle between the two layouts and compare.

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { api } from "@/api/supabaseClient";
import {
  ArrowLeft, MapPin, Check, ListTodo, MessageSquareWarning,
  CheckCircle2, CreditCard, Package, Edit, Archive, AlertTriangle, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PROJECT_STAGES } from "./projectStatuses";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { cn } from "@/lib/utils";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import ProjectPresenceIndicator from "@/components/projects/ProjectPresenceIndicator";
import ErrorBoundary from "@/components/common/ErrorBoundary";

// ────────────────────────────────────────────────────────────────────────────
// Duration helpers
// ────────────────────────────────────────────────────────────────────────────
// Past-stage display: hours + minutes only (no seconds).
function fmtHoursMinutes(seconds) {
  if (!seconds || seconds < 0) return null;
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const totalMins = Math.floor(seconds / 60);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

// Full precision (used in tooltip rows): include seconds.
function fmtFull(seconds) {
  if (!seconds || seconds < 0) return "0s";
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(seconds / 3600), rm = Math.floor((seconds % 3600) / 60), rs = seconds % 60;
  if (h < 24) return `${h}h ${rm}m ${rs}s`;
  const d = Math.floor(seconds / 86400), rh = Math.floor((seconds % 86400) / 3600);
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// Live-ticking duration (1Hz) — current-stage only.
function LiveTimer({ since, baseSeconds = 0 }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const sinceMs = since ? new Date(fixTimestamp(since)).getTime() : Date.now();
  const elapsed = Math.floor(baseSeconds + Math.max(0, (Date.now() - sinceMs) / 1000));
  return <>{fmtFull(elapsed)}</>;
}

function fmtTimestamp(ts) {
  if (!ts) return null;
  return new Date(fixTimestamp(ts)).toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Rich stage tooltip — same structure as StagePipeline (visit history,
// entered/exited timestamps, total duration, live indicator).
// ────────────────────────────────────────────────────────────────────────────
function StageTooltipBody({ stage, info, isCurrent, isCompleted }) {
  const sortedVisits = info?.dbTimers
    ? [...info.dbTimers].sort((a, b) => new Date(fixTimestamp(a.entry_time)) - new Date(fixTimestamp(b.entry_time)))
    : [];

  return (
    <div className="bg-[#202124] text-white rounded-lg overflow-hidden">
      <div className={cn(
        "px-4 py-2.5 flex items-center justify-between",
        isCurrent ? "bg-[#1a73e8]" : isCompleted ? "bg-[#34a853]" : "bg-[#5f6368]"
      )}>
        <p className="font-semibold text-sm">{stage.label}</p>
        {isCurrent ? (
          <span className="flex items-center gap-1 text-[10px] font-medium bg-white/20 rounded-full px-2 py-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            LIVE
          </span>
        ) : info?.visitCount ? (
          <span className="text-[10px] font-medium bg-white/20 rounded-full px-2 py-0.5">
            {info.visitCount}x visited
          </span>
        ) : null}
      </div>

      {info ? (
        <div className="px-4 py-3 space-y-3 text-xs">
          {sortedVisits.length > 1 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">Visit History</p>
              {sortedVisits.map((visit, i) => (
                <div key={visit.id || i} className="flex items-center justify-between bg-white/5 rounded px-2 py-1">
                  <div className="text-white/60">
                    <span className="text-white/40 text-[10px]">#{i + 1} </span>
                    <span>{fmtTimestamp(visit.entry_time)}</span>
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
                      : fmtFull(visit.duration_seconds || 0)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {sortedVisits.length === 1 && (
            <div className="space-y-1.5 text-white/80">
              <div className="flex justify-between">
                <span className="text-white/50">Entered</span>
                <span className="font-medium">{fmtTimestamp(sortedVisits[0].entry_time)}</span>
              </div>
              {sortedVisits[0].exit_time ? (
                <div className="flex justify-between">
                  <span className="text-white/50">Exited</span>
                  <span className="font-medium">{fmtTimestamp(sortedVisits[0].exit_time)}</span>
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
              {isCurrent && info.entryTime
                ? <LiveTimer since={info.entryTime} baseSeconds={info.baseSeconds || 0} />
                : fmtFull(info.durationSeconds || 0)}
            </span>
          </div>
        </div>
      ) : (
        <div className="px-4 py-3 text-xs text-white/40 text-center">Not yet reached</div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Compact horizontal stepper.
// All stages always show their label. Past = hours+minutes. Current = live
// counter with seconds. Future with no time = "--". Hover reveals the same
// rich detail popover the original StagePipeline shows.
// ────────────────────────────────────────────────────────────────────────────
function CompactStepper({ project, stageTimers, onStatusChange, canEdit, deliveryReady }) {
  const currentIdx = PROJECT_STAGES.findIndex(s => s.value === project.status);

  function getInfo(stage, idx) {
    const timers = stageTimers.filter(t => t.stage === stage.value);
    if (timers.length === 0 && idx > currentIdx) return null;

    const closedSeconds = timers
      .filter(t => t.exit_time)
      .reduce((sum, t) => sum + (t.duration_seconds || 0), 0);
    const open = timers.find(t => !t.exit_time);
    const visitCount = timers.length;

    if (idx === currentIdx) {
      return {
        isCurrent: true,
        entryTime: open?.entry_time,
        baseSeconds: closedSeconds + (open?.duration_seconds || 0),
        durationSeconds: closedSeconds + (open?.duration_seconds || 0),
        visitCount: Math.max(visitCount, 1),
        dbTimers: timers,
      };
    }
    const sorted = [...timers].sort(
      (a, b) => new Date(fixTimestamp(b.entry_time)) - new Date(fixTimestamp(a.entry_time))
    );
    return {
      isCurrent: false,
      durationSeconds: closedSeconds,
      visitCount,
      entryTime: sorted[sorted.length - 1]?.entry_time,
      exitTime: sorted[0]?.exit_time,
      dbTimers: timers,
    };
  }

  return (
    <div className="flex items-stretch gap-1 overflow-x-auto py-1 scrollbar-thin">
      {PROJECT_STAGES.map((stage, i) => {
        const info = getInfo(stage, i);
        const isPast = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isFuture = i > currentIdx;
        const isCompleted = isPast;
        const visits = info?.visitCount > 1 ? info.visitCount : null;
        const blockedDeliver = stage.value === 'delivered' && !deliveryReady && isFuture;
        const blockedRevision = stage.value === 'in_revision';
        const disabled = !canEdit || blockedRevision || blockedDeliver;

        return (
          <Tooltip key={stage.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                onClick={() => !disabled && onStatusChange?.(stage.value)}
                className={cn(
                  "relative flex flex-col items-center justify-center px-2 py-1 rounded-md transition-colors flex-shrink-0 min-w-[80px] outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary",
                  isCurrent && "bg-primary/10 ring-1 ring-primary/30",
                  isPast && "hover:bg-muted/60",
                  isFuture && "opacity-55 hover:opacity-90",
                  !disabled ? "cursor-pointer" : "cursor-default",
                )}
                aria-label={`${stage.label} - ${isCompleted ? "completed" : isCurrent ? "current" : "future"}`}
              >
                {visits && (
                  <span className="absolute top-0 right-1 text-[8px] font-bold text-amber-600 dark:text-amber-400 leading-none">
                    ×{visits}
                  </span>
                )}
                {blockedDeliver && (
                  <span className="absolute -top-0.5 -right-0.5">
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                  </span>
                )}
                <span className="flex items-center gap-1 mb-0.5">
                  <span className={cn(
                    "flex items-center justify-center w-3.5 h-3.5 rounded-full text-[8px] font-bold",
                    isPast && "bg-emerald-500 text-white",
                    isCurrent && "bg-primary text-primary-foreground",
                    isFuture && !blockedDeliver && "bg-muted text-muted-foreground border border-border",
                    blockedDeliver && "bg-muted/40 text-muted-foreground/60 border border-dashed border-border",
                  )}>
                    {isPast ? <Check className="h-2.5 w-2.5" strokeWidth={3} />
                     : blockedDeliver ? <Lock className="h-2 w-2" />
                     : i + 1}
                  </span>
                  {isCurrent && (
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  )}
                </span>
                <span className={cn(
                  "text-[10px] font-semibold leading-tight whitespace-nowrap",
                  isCurrent ? "text-foreground" : "text-muted-foreground",
                )}>
                  {stage.label}
                </span>
                <span className={cn(
                  "text-[10px] tabular-nums leading-tight mt-0.5",
                  isCurrent ? "text-primary font-semibold" : "text-muted-foreground/80",
                )}>
                  {isCurrent && info?.entryTime ? (
                    <LiveTimer since={info.entryTime} baseSeconds={info.baseSeconds} />
                  ) : info?.durationSeconds > 0 ? (
                    fmtHoursMinutes(info.durationSeconds)
                  ) : (
                    <span className="opacity-40">--</span>
                  )}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="p-0 overflow-hidden shadow-xl border-0 w-64">
              {blockedRevision && isFuture ? (
                <div className="bg-[#202124] text-white rounded-lg overflow-hidden px-4 py-3 text-xs">
                  In Revision is set automatically when a revision is created. It cannot be set manually.
                </div>
              ) : blockedDeliver ? (
                <div className="bg-[#202124] text-white rounded-lg overflow-hidden">
                  <div className="px-4 py-2.5 bg-amber-600 flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <p className="font-semibold text-sm">Not Ready to Deliver</p>
                  </div>
                  <div className="px-4 py-3 text-xs text-white/80">
                    Tasks are still incomplete.
                  </div>
                </div>
              ) : (
                <StageTooltipBody stage={stage} info={info} isCurrent={isCurrent} isCompleted={isCompleted} />
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Inline KPI chip — Tasks / Requests
// ────────────────────────────────────────────────────────────────────────────
function KpiChip({ icon: Icon, label, done, total, pct, extra, href }) {
  const barClass = pct === 100 ? "bg-emerald-500"
    : pct >= 75 ? "bg-emerald-500"
    : pct >= 50 ? "bg-blue-500"
    : pct >= 25 ? "bg-amber-500" : "bg-orange-500";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={href}
          className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity flex-shrink-0"
        >
          <Icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-muted-foreground text-xs">{label}</span>
          <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full transition-all duration-700", barClass)} style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs tabular-nums font-semibold">{done}/{total}</span>
          {pct === 100 && <CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" />}
          {extra}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{done} done · {total - done} remaining{extra ? ` · ${extra.props['data-tooltip-extra'] || ''}` : ''}</TooltipContent>
    </Tooltip>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────
export default function ProjectSummaryHeader({
  project,
  projectTasks = [],
  revisions = [],
  approvalActivity,
  canEdit,
  currentUser,
  onStatusChange,
  onEditClick,
  onArchiveClick,
  onTogglePayment,
  onTogglePartialDelivery,
}) {
  const isPinned = !!(project?.confirmed_lat && project?.confirmed_lng);

  // Stage timers (same source-of-truth as StagePipeline)
  // Subscription replaces optimistic synthetic timers as real DB rows arrive.
  const [stageTimers, setStageTimers] = useState([]);
  const mountedRef = useRef(true);
  useEffect(() => {
    if (!project?.id) return;
    mountedRef.current = true;
    api.entities.ProjectStageTimer.filter({ project_id: project.id }).then(timers => {
      if (mountedRef.current) setStageTimers(timers || []);
    });
    const unsub = api.entities.ProjectStageTimer.subscribe((event) => {
      if (!mountedRef.current) return;
      setStageTimers(prev => {
        if (event.type === 'create' && event.data?.project_id === project.id) {
          // Replace any optimistic open timer for the same stage with the real row.
          const optIdx = prev.findIndex(t => t._optimistic && t.stage === event.data.stage && !t.exit_time);
          if (optIdx >= 0) {
            const next = [...prev];
            next[optIdx] = event.data;
            return next;
          }
          if (prev.some(t => t.id === event.id)) return prev;
          return [...prev, event.data];
        }
        if (event.type === 'update') return prev.map(t => t.id === event.id ? event.data : t);
        if (event.type === 'delete') return prev.filter(t => t.id !== event.id);
        return prev;
      });
    });
    return () => { mountedRef.current = false; unsub(); };
  }, [project?.id]);

  // Optimistic stage transition: close the current open timer locally and
  // open a synthetic timer for the target stage so the stepper, durations,
  // and tooltip update instantly. Realtime later replaces the synthetic row.
  const handleStageChange = useCallback((newStatus) => {
    if (!project || !newStatus || newStatus === project.status) return;
    const oldStatus = project.status;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    setStageTimers(prev => {
      const next = prev.map(t => {
        if (!t.exit_time && t.stage === oldStatus) {
          const entryMs = new Date(fixTimestamp(t.entry_time)).getTime();
          const elapsed = Math.max(0, Math.floor((nowMs - entryMs) / 1000));
          return {
            ...t,
            exit_time: nowIso,
            duration_seconds: (t.duration_seconds || 0) + elapsed,
          };
        }
        return t;
      });
      next.push({
        id: `optimistic-${nowMs}`,
        project_id: project.id,
        stage: newStatus,
        entry_time: nowIso,
        exit_time: null,
        duration_seconds: 0,
        _optimistic: true,
      });
      return next;
    });

    onStatusChange?.(newStatus);
  }, [project, onStatusChange]);

  // If the project status reverts (e.g. mutation rolled back) or settles to
  // something other than what we optimistically opened, drop stale synthetic
  // timers so the stepper reflects reality.
  useEffect(() => {
    if (!project?.status) return;
    setStageTimers(prev => {
      let changed = false;
      const next = prev.filter(t => {
        if (t._optimistic && !t.exit_time && t.stage !== project.status) {
          changed = true;
          return false;
        }
        return true;
      });
      return changed ? next : prev;
    });
  }, [project?.status]);

  // Tasks / Requests stats
  const taskStats = useMemo(() => {
    const active = projectTasks.filter(t => !t.is_deleted && !t.is_archived);
    const done = active.filter(t => t.is_completed).length;
    return { total: active.length, done, pct: active.length ? Math.round((done / active.length) * 100) : 0 };
  }, [projectTasks]);

  const reqStats = useMemo(() => {
    const active = revisions.filter(r => r.status !== 'cancelled');
    const done = active.filter(r => r.status === 'completed' || r.status === 'delivered').length;
    const stuck = revisions.filter(r => r.status === 'stuck').length;
    return {
      total: active.length, done, stuck,
      pct: active.length ? Math.round((done / active.length) * 100) : 0,
    };
  }, [revisions]);

  const deliveryReady = taskStats.total === 0 || taskStats.done === taskStats.total;
  const isPaid = project?.payment_status === 'paid';
  const isPartial = !!project?.partially_delivered;

  if (!project) return null;

  const currentStage = PROJECT_STAGES.find(s => s.value === project.status);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
        {/* ─── Row 1: Title bar ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/20">
          <Link to={createPageUrl("Projects")} className="flex-shrink-0">
            <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-muted/80" aria-label="Back">
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
          </Link>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <h1
                className="text-base lg:text-lg font-bold tracking-tight leading-tight truncate"
                title={project.title}
              >
                {project.title}
              </h1>
              <FavoriteButton
                projectId={project.id}
                projectTitle={project.title}
                propertyAddress={project.property_address}
                size="sm"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={createPageUrl('ProjectLocation') + `?id=${project.id}`}
                    className="flex-shrink-0 inline-flex"
                  >
                    <MapPin className={cn(
                      "h-3.5 w-3.5 transition-colors",
                      isPinned ? "fill-emerald-500/20 text-emerald-600" : "text-muted-foreground/40 hover:text-emerald-500"
                    )} />
                  </Link>
                </TooltipTrigger>
                <TooltipContent>{isPinned ? "Confirmed location — click to view" : "Set confirmed location pin"}</TooltipContent>
              </Tooltip>

              {currentStage && (
                <span className={cn(
                  "text-[11px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0",
                  currentStage.color, currentStage.textColor, "border", currentStage.borderColor
                )}>
                  {currentStage.label}
                </span>
              )}

              {approvalActivity && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 px-1.5 py-0.5 rounded flex-shrink-0">
                      <CheckCircle2 className="h-3 w-3" />
                      <span className="truncate max-w-[100px]">{approvalActivity.user_name || 'admin'}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Approved by {approvalActivity.user_name || 'admin'}
                    {approvalActivity.created_at && (
                      <> on {new Date(approvalActivity.created_at).toLocaleString('en-AU', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                      })}</>
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            <div className="text-[11px] text-muted-foreground truncate mt-0.5">
              {project.property_address}
            </div>
          </div>

          {/* Right-aligned status / actions */}
          <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
            {/* Live presence — restored */}
            <ErrorBoundary>
              <ProjectPresenceIndicator projectId={project.id} currentUser={currentUser} />
            </ErrorBoundary>

            {/* Paid */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => canEdit && onTogglePayment?.(isPaid ? 'unpaid' : 'paid')}
                  disabled={!canEdit}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 h-7 rounded text-[11px] font-semibold border transition-colors",
                    isPaid
                      ? "bg-green-500 text-white border-green-600 hover:bg-green-600"
                      : "bg-muted text-muted-foreground border-border hover:bg-muted/80",
                    !canEdit && "opacity-60 cursor-not-allowed"
                  )}
                  aria-label={`Payment: ${isPaid ? 'paid' : 'unpaid'}`}
                >
                  <CreditCard className="h-3 w-3" />
                  {isPaid ? "✓ Paid" : "○ Unpaid"}
                </button>
              </TooltipTrigger>
              <TooltipContent>{canEdit ? `Click to mark ${isPaid ? 'unpaid' : 'paid'}` : "Read-only"}</TooltipContent>
            </Tooltip>

            {/* Partially delivered — keep the words */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => canEdit && onTogglePartialDelivery?.(!isPartial)}
                  disabled={!canEdit}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 h-7 rounded text-[11px] font-semibold border transition-colors",
                    isPartial
                      ? "bg-indigo-600 text-white border-indigo-700 hover:bg-indigo-700"
                      : "bg-muted text-muted-foreground border-border hover:bg-muted/80",
                    !canEdit && "opacity-60 cursor-not-allowed"
                  )}
                  aria-label={isPartial ? "Partially delivered: yes" : "Partially delivered: no"}
                >
                  <Package className="h-3 w-3" />
                  {isPartial ? "✓ Partially Delivered" : "○ Partially Delivered"}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {isPartial
                  ? `Partially delivered${project.partially_delivered_by ? ` by ${project.partially_delivered_by}` : ''}`
                  : 'Mark as partially delivered'}
              </TooltipContent>
            </Tooltip>

            {canEdit && (
              <>
                <Button
                  variant="outline" size="sm" onClick={onEditClick}
                  className="h-7 text-xs px-2"
                >
                  <Edit className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline ml-1">Edit</span>
                </Button>
                <Button
                  variant="outline" size="icon"
                  onClick={onArchiveClick}
                  className="h-7 w-7 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950/30"
                  aria-label="Archive"
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
        </div>

        {/* ─── Row 2: Pipeline + Tasks/Requests on the same line ───────────── */}
        <div className="flex items-center gap-3 px-3 py-1">
          {/* Stepper grows + scrolls horizontally if it overflows */}
          <div className="flex-1 min-w-0">
            <CompactStepper
              project={project}
              stageTimers={stageTimers}
              onStatusChange={handleStageChange}
              canEdit={canEdit}
              deliveryReady={deliveryReady}
            />
          </div>

          {/* KPI strip pinned right */}
          <div className="flex items-center gap-4 flex-shrink-0 pl-3 border-l border-border/60">
            {taskStats.total > 0 && (
              <KpiChip
                icon={ListTodo}
                label="Tasks"
                done={taskStats.done}
                total={taskStats.total}
                pct={taskStats.pct}
                href={createPageUrl(`ProjectDetails?id=${project.id}&tab=tasks`)}
              />
            )}
            {reqStats.total > 0 && (
              <KpiChip
                icon={MessageSquareWarning}
                label="Requests"
                done={reqStats.done}
                total={reqStats.total}
                pct={reqStats.pct}
                href={createPageUrl(`ProjectDetails?id=${project.id}&tab=revisions`)}
                extra={reqStats.stuck > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-orange-600 dark:text-orange-400">
                    <MessageSquareWarning className="h-3 w-3" />{reqStats.stuck} stuck
                  </span>
                ) : null}
              />
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

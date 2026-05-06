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
// All data and handlers stay the same — only the layout collapses to ~180px.
// Stage durations are computed from ProjectStageTimer with the same logic as
// StagePipeline (live timer for current stage, summed closed timers for past).
//
// Wired in ProjectDetails.jsx behind a `?compact=1` query param so you can
// toggle between the two layouts and compare.

import React, { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { api } from "@/api/supabaseClient";
import {
  ArrowLeft, MapPin, Check, ChevronRight, ListTodo, MessageSquareWarning,
  CheckCircle2, CreditCard, Package, Edit, Archive, AlertTriangle, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PROJECT_STAGES } from "./projectStatuses";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { cn } from "@/lib/utils";
import FavoriteButton from "@/components/favorites/FavoriteButton";

// ────────────────────────────────────────────────────────────────────────────
// Duration helpers (mirror StagePipeline.formatDurationCompact for consistency)
// ────────────────────────────────────────────────────────────────────────────
function fmtCompact(seconds) {
  if (!seconds || seconds < 0) return null;
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(seconds / 3600);
  if (h < 24) return `${h}h`;
  const d = Math.floor(seconds / 86400);
  return `${d}d`;
}

function fmtFull(seconds) {
  if (!seconds || seconds < 0) return "0s";
  seconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(seconds / 3600), rm = Math.floor((seconds % 3600) / 60);
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(seconds / 86400), rh = Math.floor((seconds % 86400) / 3600);
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// Live-ticking duration for the current stage (1Hz).
function LiveDuration({ since, baseSeconds = 0 }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const sinceMs = since ? new Date(fixTimestamp(since)).getTime() : Date.now();
  const elapsed = Math.floor(baseSeconds + Math.max(0, (Date.now() - sinceMs) / 1000));
  return <>{fmtCompact(elapsed)}</>;
}

// ────────────────────────────────────────────────────────────────────────────
// Compact horizontal stepper — replaces the chevron StagePipeline.
// Each stage = small numbered/checked dot + (when current) inline label,
// with duration as a superscript-style badge and visit count for revisits.
// Hover reveals full entry/exit/duration in a tooltip.
// ────────────────────────────────────────────────────────────────────────────
function CompactStepper({ project, stageTimers, onStatusChange, canEdit, deliveryReady }) {
  const currentIdx = PROJECT_STAGES.findIndex(s => s.value === project.status);

  function getInfo(stage, idx) {
    const timers = stageTimers.filter(t => t.stage === stage.value);
    if (timers.length === 0 && idx > currentIdx) return null;

    const closedSeconds = timers.filter(t => t.exit_time).reduce((sum, t) => sum + (t.duration_seconds || 0), 0);
    const open = timers.find(t => !t.exit_time);
    const visitCount = timers.length;

    if (idx === currentIdx) {
      return {
        isCurrent: true,
        entryTime: open?.entry_time,
        baseSeconds: closedSeconds,
        visitCount: Math.max(visitCount, 1),
      };
    }
    return {
      isCurrent: false,
      durationSeconds: closedSeconds,
      visitCount,
      entryTime: timers[0]?.entry_time,
      exitTime: [...timers].sort((a, b) => new Date(b.exit_time || 0) - new Date(a.exit_time || 0))[0]?.exit_time,
    };
  }

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto py-1 px-1 -mx-1 scrollbar-thin">
      {PROJECT_STAGES.map((stage, i) => {
        const info = getInfo(stage, i);
        const isPast = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isFuture = i > currentIdx;
        const visits = info?.visitCount > 1 ? info.visitCount : null;
        const blockedDeliver = stage.value === 'delivered' && !deliveryReady && !isPast && !isCurrent;
        const blockedRevision = stage.value === 'in_revision';

        return (
          <React.Fragment key={stage.value}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={!canEdit || blockedRevision || blockedDeliver}
                  onClick={() => onStatusChange?.(stage.value)}
                  className={cn(
                    "group flex items-center gap-1 px-1.5 py-1 rounded transition-colors flex-shrink-0",
                    isCurrent && "bg-primary/10 ring-1 ring-primary/30",
                    isPast && "hover:bg-muted/60",
                    isFuture && "opacity-50 hover:opacity-90",
                    canEdit && !blockedRevision && !blockedDeliver ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <span className={cn(
                    "flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold flex-shrink-0",
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
                    <span className="text-xs font-semibold text-foreground whitespace-nowrap">
                      {stage.label}
                    </span>
                  )}
                  {isCurrent && info?.entryTime && (
                    <span className="text-[10px] tabular-nums text-primary font-semibold">
                      <LiveDuration since={info.entryTime} baseSeconds={info.baseSeconds} />
                    </span>
                  )}
                  {!isCurrent && info?.durationSeconds > 0 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {fmtCompact(info.durationSeconds)}
                    </span>
                  )}
                  {visits && (
                    <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 ml-0.5">
                      ×{visits}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-xs">
                <div className="font-semibold">{stage.label}</div>
                {info?.entryTime && (
                  <div className="text-muted-foreground">
                    Entered {new Date(fixTimestamp(info.entryTime)).toLocaleString('en-AU', {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                    })}
                  </div>
                )}
                {info?.exitTime && (
                  <div className="text-muted-foreground">
                    Exited {new Date(fixTimestamp(info.exitTime)).toLocaleString('en-AU', {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                    })}
                  </div>
                )}
                {info?.durationSeconds > 0 && (
                  <div className="text-muted-foreground">Total time: {fmtFull(info.durationSeconds)}</div>
                )}
                {visits && (
                  <div className="text-amber-600 dark:text-amber-400">Re-entered {visits} times</div>
                )}
                {blockedRevision && (
                  <div className="text-muted-foreground italic">Auto-managed by revision system</div>
                )}
                {blockedDeliver && (
                  <div className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />Tasks incomplete
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
            {i < PROJECT_STAGES.length - 1 && (
              <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/30 flex-shrink-0" />
            )}
          </React.Fragment>
        );
      })}
    </div>
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
  onStatusChange,
  onEditClick,
  onArchiveClick,
  onTogglePayment,
  onTogglePartialDelivery,
}) {
  const isPinned = !!(project?.confirmed_lat && project?.confirmed_lng);

  // ── Stage timers (same source-of-truth as StagePipeline) ─────────────────
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

  // ── Tasks / Requests stats ────────────────────────────────────────────────
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
          <div className="flex items-center gap-1 flex-shrink-0">
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
                  {isPaid ? "Paid" : "Unpaid"}
                </button>
              </TooltipTrigger>
              <TooltipContent>{canEdit ? `Click to mark ${isPaid ? 'unpaid' : 'paid'}` : "Read-only"}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => canEdit && onTogglePartialDelivery?.(!isPartial)}
                  disabled={!canEdit}
                  className={cn(
                    "inline-flex items-center justify-center w-7 h-7 rounded border transition-colors",
                    isPartial
                      ? "bg-indigo-600 text-white border-indigo-700 hover:bg-indigo-700"
                      : "bg-muted text-muted-foreground border-border hover:bg-muted/80",
                    !canEdit && "opacity-60 cursor-not-allowed"
                  )}
                  aria-label={isPartial ? "Partially delivered: yes" : "Partially delivered: no"}
                >
                  <Package className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{isPartial ? "Partially delivered" : "Mark as partially delivered"}</TooltipContent>
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

        {/* ─── Row 2: Compact pipeline ──────────────────────────────────────── */}
        <div className="px-3 border-b">
          <CompactStepper
            project={project}
            stageTimers={stageTimers}
            onStatusChange={onStatusChange}
            canEdit={canEdit}
            deliveryReady={deliveryReady}
          />
        </div>

        {/* ─── Row 3: KPI strip (Tasks / Requests) ─────────────────────────── */}
        <div className="flex items-center gap-x-5 gap-y-1 px-3 py-1.5 text-xs flex-wrap">
          {taskStats.total > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to={createPageUrl(`ProjectDetails?id=${project.id}&tab=tasks`)}
                  className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
                >
                  <ListTodo className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-muted-foreground">Tasks</span>
                  <div className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-700",
                        taskStats.pct === 100 ? "bg-emerald-500"
                          : taskStats.pct >= 75 ? "bg-emerald-500"
                          : taskStats.pct >= 50 ? "bg-blue-500"
                          : taskStats.pct >= 25 ? "bg-amber-500" : "bg-orange-500"
                      )}
                      style={{ width: `${taskStats.pct}%` }}
                    />
                  </div>
                  <span className="tabular-nums font-semibold">
                    {taskStats.done}/{taskStats.total}
                  </span>
                  {taskStats.pct === 100 && (
                    <CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" />
                  )}
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                {taskStats.done} done · {taskStats.total - taskStats.done} remaining
              </TooltipContent>
            </Tooltip>
          )}

          {reqStats.total > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to={createPageUrl(`ProjectDetails?id=${project.id}&tab=revisions`)}
                  className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
                >
                  <MessageSquareWarning className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-muted-foreground">Requests</span>
                  <div className="relative h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-700",
                        reqStats.pct === 100 ? "bg-emerald-500"
                          : reqStats.pct >= 75 ? "bg-emerald-500"
                          : reqStats.pct >= 50 ? "bg-blue-500"
                          : reqStats.pct >= 25 ? "bg-amber-500" : "bg-orange-500"
                      )}
                      style={{ width: `${reqStats.pct}%` }}
                    />
                  </div>
                  <span className="tabular-nums font-semibold">
                    {reqStats.done}/{reqStats.total}
                  </span>
                  {reqStats.pct === 100 && (
                    <CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" />
                  )}
                  {reqStats.stuck > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-orange-600 dark:text-orange-400">
                      <MessageSquareWarning className="h-3 w-3" />{reqStats.stuck} stuck
                    </span>
                  )}
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                {reqStats.done} resolved · {reqStats.total - reqStats.done} open
                {reqStats.stuck > 0 && <> · {reqStats.stuck} stuck</>}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * ProjectDetailsV2 — UX redesign POC, hooked to live data.
 *
 * Parallel to ProjectDetails.jsx. Reachable at /ProjectDetailsV2?id=<projectId>.
 * Renders inside the auth-protected app shell like every other page.
 *
 * Layout (top → bottom):
 *   ┌─ Command Rail   sticky 56px  back · title · status pills · primary CTA · overflow
 *   ├─ Stage Strip    sticky 44px  compressed pipeline w/ ping
 *   └─ Body 3-zone
 *      ├─ Workbench   220px       section nav with counts (replaces tabs)
 *      ├─ Canvas      fluid       active-section view + activity timeline
 *      └─ Context     320–360px   accordion: People · Pricing · Schedule · Staff · Property · Audit
 *
 * Inner subtabs are flattened wherever the dead-space hit was unjustified —
 * Tonomo is rebuilt as a card stack (no inner tabs); the rest reuse the proven
 * components from ProjectDetails.jsx so no module/feature is missing.
 */
import React, { useState, useMemo, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useSmartEntityData, useSmartEntityList } from "@/components/hooks/useSmartEntityData";
import { useProjectTasks } from "@/hooks/useProjectTasks";
import { useCurrentUser, usePermissions } from "@/components/auth/PermissionGuard";
import { useEntityAccess } from "@/components/auth/useEntityAccess";
import { updateEntityInCache } from "@/components/hooks/useEntityData";
import { invalidateProjectCaches } from "@/lib/invalidateProjectCaches";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";
import { stageLabel } from "@/components/projects/projectStatuses";
import { writeFeedEvent } from "@/components/notifications/createNotification";
import { toast } from "sonner";
import {
  ArrowLeft, ChevronRight, ChevronDown, MoreHorizontal, Sparkles,
  CheckCircle2, Clock, AlertTriangle, MapPin, Copy, Mail, Phone, Building2,
  CreditCard, Plane, Image as ImageIcon, FileText,
  ListChecks, GitPullRequest, Timer, MessageSquare, History, CloudSun,
  ExternalLink, Edit3, Archive, Search,
  Activity, Zap, Star, AlertCircle, Layers, Database, Radar
} from "lucide-react";

// Heavy children — lazy-load so initial paint isn't blocked
const TaskManagement       = lazy(() => import("@/components/projects/TaskManagement"));
const ProjectRevisionsTab  = lazy(() => import("@/components/revisions/ProjectRevisionsTab"));
const EffortLoggingTab     = lazy(() => import("@/components/projects/EffortLoggingTab"));
const ProjectMediaGallery  = lazy(() => import("@/components/projects/ProjectMediaGallery"));
const ProjectFilesTab      = lazy(() => import("@/components/projects/ProjectFilesTab"));
const ProjectDronesTab     = lazy(() => import("@/components/projects/ProjectDronesTab"));
const ProjectShortlistingTab = lazy(() => import("@/components/projects/ProjectShortlistingTab"));
const ProjectActivityHub   = lazy(() => import("@/components/projects/ProjectActivityHub"));
const ProjectStaffBar      = lazy(() => import("@/components/projects/ProjectStaffBar"));
const ProjectHealthIndicator = lazy(() => import("@/components/projects/ProjectHealthIndicator"));
const ProjectPresenceIndicator = lazy(() => import("@/components/projects/ProjectPresenceIndicator"));
const ProjectValidationBanner = lazy(() => import("@/components/projects/ProjectValidationBanner"));
const ConcurrentEditDetector = lazy(() => import("@/components/projects/ConcurrentEditDetector"));
const ProjectForm          = lazy(() => import("@/components/projects/ProjectForm"));
const EmailComposeDialog   = lazy(() => import("@/components/email/EmailComposeDialog"));
const ProjectPricingTable  = lazy(() => import("@/components/projects/ProjectPricingTable"));

// ─────────────────────────────────────────────────────────────────────────────
// Stage config
const STAGE_ORDER = [
  "pending_review", "to_be_scheduled", "scheduled", "onsite",
  "uploaded", "in_progress", "in_production", "in_revision", "delivered"
];

const STAGE_DOT = {
  pending_review: "bg-amber-500",
  to_be_scheduled: "bg-slate-400",
  scheduled: "bg-blue-500",
  onsite: "bg-yellow-500",
  uploaded: "bg-orange-500",
  in_progress: "bg-violet-500",
  in_production: "bg-cyan-500",
  in_revision: "bg-rose-500",
  delivered: "bg-emerald-500",
  cancelled: "bg-zinc-400",
};

const fmtDate = (d) => { try { return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" }); } catch { return "—"; } };
const fmtTime = (d) => { try { return new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }); } catch { return "—"; } };
const fmtMoney = (n) => n != null && !isNaN(Number(n)) ? `$${Number(n).toLocaleString("en-AU", { maximumFractionDigits: 0 })}` : "—";

// ─────────────────────────────────────────────────────────────────────────────
// Atoms
function Chip({ children, tone = "neutral", className }) {
  const tones = {
    neutral: "bg-muted/60 text-muted-foreground border-transparent",
    amber: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
    red: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
    blue: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
    violet: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
  };
  return (
    <span className={cn(
      "inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-medium border whitespace-nowrap",
      tones[tone] || tones.neutral, className
    )}>{children}</span>
  );
}

function StatusDot({ tone = "neutral", className }) {
  const tones = { neutral: "bg-zinc-400", amber: "bg-amber-500", green: "bg-emerald-500", red: "bg-rose-500", blue: "bg-blue-500", violet: "bg-violet-500" };
  return <span className={cn("inline-block w-1.5 h-1.5 rounded-full", tones[tone] || tones.neutral, className)} />;
}

function KpiStat({ label, value, sub, progress, tone = "neutral" }) {
  const bars = { neutral: "bg-foreground/70", blue: "bg-blue-500", green: "bg-emerald-500", amber: "bg-amber-500", violet: "bg-violet-500", red: "bg-rose-500" };
  return (
    <div className="flex flex-col gap-1 min-w-[88px]">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-bold tabular-nums leading-none">{value}</span>
        {sub && <span className="text-[10.5px] text-muted-foreground tabular-nums">{sub}</span>}
      </div>
      {progress !== undefined && (
        <div className="h-1 rounded-full bg-muted/60 overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", bars[tone] || bars.neutral)} style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function Section({ title, summary, children, className, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn("border-b border-border last:border-b-0", className)}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-2 px-4 h-10 text-left hover:bg-muted/30 transition-colors group">
        <div className="flex items-center gap-1.5 min-w-0">
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground", !open && "-rotate-90")} />
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</span>
        </div>
        {summary && !open && <span className="text-[11px] text-muted-foreground/80 truncate min-w-0 ml-2">{summary}</span>}
      </button>
      {open && <div className="px-4 pb-4 pt-0.5">{children}</div>}
    </section>
  );
}

function CanvasFallback({ label = "Loading…" }) {
  return (
    <div className="border border-dashed border-border rounded-lg py-12 text-center text-xs text-muted-foreground">
      <div className="inline-flex items-center gap-2">
        <div className="w-3 h-3 rounded-full border-2 border-border border-t-foreground animate-spin" />
        {label}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Rail
function CommandRail({ project, projectId, agent, agency, paymentTone, paymentLabel, primaryAction, onPrimaryAction, onEdit, onArchive, onEmailAgent, currentUser }) {
  const navigate = useNavigate();
  const handleCopyAddress = () => {
    if (project?.property_address) {
      navigator.clipboard.writeText(project.property_address);
      toast.success("Address copied");
    }
  };

  const tone = project?.status === "pending_review" ? "amber"
             : project?.status === "delivered"      ? "green"
             : project?.status === "in_revision"    ? "red"
             : "blue";

  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border h-14 flex items-center px-4 gap-3">
      <Link to={createPageUrl("Projects")} className="inline-flex items-center gap-1 h-7 px-1.5 -ml-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 text-[12px] flex-shrink-0 transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Projects</span>
      </Link>
      <div className="h-5 w-px bg-border flex-shrink-0" />

      <div className="min-w-0 flex items-center gap-2.5">
        <div className={cn("w-1 self-stretch rounded-full flex-shrink-0", STAGE_DOT[project?.status] || "bg-muted")} title={stageLabel(project?.status)} style={{ minHeight: 28 }} />
        <div className="min-w-0 leading-tight py-0.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <h1 className="text-[14px] font-semibold tracking-tight truncate" title={project?.title || project?.property_address}>
              {project?.title || project?.property_address || "Loading…"}
            </h1>
            {project?.is_first_order && <span title="First order with this client" className="text-amber-500 text-[12px] leading-none">★</span>}
            {project?.is_archived && <Chip tone="neutral">Archived</Chip>}
          </div>
          <button onClick={handleCopyAddress} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground truncate group max-w-full" title="Copy address">
            <MapPin className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">{project?.property_address || "—"}</span>
            <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 flex-shrink-0" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 ml-1 flex-shrink-0">
        <Chip tone={tone}><StatusDot tone={tone} />{stageLabel(project?.status) || "—"}</Chip>
        <Chip tone={paymentTone}><CreditCard className="h-2.5 w-2.5" />{paymentLabel}</Chip>
        {project?.partially_delivered && <Chip tone="violet">Partial</Chip>}
      </div>

      <div className="flex-1" />

      {/* Live presence */}
      {projectId && currentUser && (
        <Suspense fallback={null}>
          <ProjectPresenceIndicator projectId={projectId} currentUser={currentUser} />
        </Suspense>
      )}

      {primaryAction && (
        <button onClick={onPrimaryAction} className="hidden md:inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-foreground text-background text-[12px] font-semibold shadow-sm hover:bg-foreground/90 transition-colors">
          <Sparkles className="h-3 w-3" />{primaryAction}
        </button>
      )}

      <div className="relative">
        <button onClick={() => setMenuOpen(o => !o)} className="h-8 w-8 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground inline-flex items-center justify-center transition-colors" title="More actions">
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute top-full right-0 mt-1 w-48 bg-background border border-border rounded-lg shadow-lg z-50 py-1">
              <MenuItem icon={Edit3} onClick={() => { setMenuOpen(false); onEdit?.(); }}>Edit project</MenuItem>
              <MenuItem icon={Mail} onClick={() => { setMenuOpen(false); onEmailAgent?.(); }} disabled={!agent?.email}>Email agent</MenuItem>
              <MenuItem icon={ExternalLink} onClick={() => { setMenuOpen(false); navigator.clipboard.writeText(window.location.href); toast.success("URL copied"); }}>Copy link</MenuItem>
              <div className="border-t border-border my-1" />
              <MenuItem icon={Archive} onClick={() => { setMenuOpen(false); onArchive?.(); }} tone="amber">{project?.is_archived ? "Unarchive" : "Archive"}</MenuItem>
              <div className="border-t border-border my-1" />
              <MenuItem icon={ChevronRight} onClick={() => { setMenuOpen(false); navigate(createPageUrl(`ProjectDetails?id=${projectId}`)); }}>Open in V1</MenuItem>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, tone, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} className={cn(
      "w-full flex items-center gap-2 px-3 h-8 text-[12.5px] text-left transition-colors",
      disabled ? "text-muted-foreground/40 cursor-not-allowed" : "hover:bg-muted text-foreground",
      tone === "amber" && !disabled && "text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
    )}>
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate">{children}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage Strip
function StageStrip({ status, onChange, lastChange, isPending }) {
  const activeIdx = STAGE_ORDER.indexOf(status);
  const inStageMs = lastChange ? (Date.now() - new Date(lastChange).getTime()) : 0;
  const inStageStr = inStageMs > 0 ? formatDuration(inStageMs) : "—";

  return (
    <div className="sticky top-14 z-20 bg-background/90 backdrop-blur-md border-b border-border h-12 flex items-center px-4 gap-3 overflow-x-auto">
      <div className="flex items-stretch h-8 rounded-lg overflow-hidden border border-border bg-muted/30 min-w-fit shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]">
        {STAGE_ORDER.map((stage, i) => {
          const isActive = i === activeIdx;
          const isDone = i < activeIdx;
          return (
            <button
              key={stage}
              onClick={() => onChange?.(stage)}
              disabled={isPending}
              className={cn(
                "group flex items-center px-3 text-[11px] font-medium border-r border-border last:border-r-0 transition-all whitespace-nowrap",
                isActive && "bg-foreground text-background font-semibold shadow-sm",
                isDone && !isActive && "bg-emerald-50/70 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 hover:bg-emerald-100/70",
                !isActive && !isDone && "text-muted-foreground hover:bg-background hover:text-foreground",
                isPending && "opacity-60 cursor-not-allowed"
              )}
              title={stageLabel(stage)}
            >
              {isDone && <CheckCircle2 className="h-3 w-3 mr-1 opacity-80" />}
              {isActive && (
                <span className="relative mr-1.5 flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-background opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-background" />
                </span>
              )}
              <span>{stageLabel(stage)}</span>
              {isActive && <span className="ml-2 text-[10px] font-normal opacity-70 tabular-nums hidden xl:inline">· {inStageStr}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />
      <div className="hidden md:flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{inStageStr} in stage</span>
      </div>
    </div>
  );
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workbench
const SECTION_KEYS = ["tasks", "requests", "effort", "notes", "media", "files", "shortlisting", "drones", "tonomo"];

function Workbench({ active, onSelect, counts, hasDroneWork, isTonomoProject, isEmployeeOrAbove, onCommandPalette }) {
  const groups = useMemo(() => {
    const work = [
      { key: "tasks", label: "Tasks", icon: ListChecks },
      { key: "requests", label: "Requests", icon: GitPullRequest },
      { key: "effort", label: "Effort", icon: Timer },
      { key: "notes", label: "Notes", icon: MessageSquare },
    ];
    const assets = [
      { key: "media", label: "Media", icon: ImageIcon },
      { key: "files", label: "Files", icon: FileText },
    ];
    const addons = [];
    if (isEmployeeOrAbove) addons.push({ key: "shortlisting", label: "Shortlisting", icon: Layers });
    if (hasDroneWork) addons.push({ key: "drones", label: "Drones", icon: Plane });
    if (isTonomoProject) addons.push({ key: "tonomo", label: "Tonomo", icon: Database });
    return [
      { label: "Work", items: work },
      { label: "Assets", items: assets },
      ...(addons.length ? [{ label: "Add-ons", items: addons }] : []),
    ];
  }, [hasDroneWork, isTonomoProject, isEmployeeOrAbove]);

  return (
    <aside className="hidden lg:flex flex-col w-[220px] flex-shrink-0 border-r border-border bg-muted/10 overflow-y-auto sticky top-[104px] max-h-[calc(100vh-104px)]">
      <div className="p-3 pb-1">
        <button
          onClick={onCommandPalette}
          className="w-full inline-flex items-center justify-between gap-2 h-8 px-2 rounded-md border border-border bg-background hover:bg-muted/40 text-xs text-muted-foreground transition-colors"
        >
          <span className="inline-flex items-center gap-1.5"><Search className="h-3 w-3" />Search…</span>
          <kbd className="text-[10px] tabular-nums px-1 py-0.5 rounded border border-border text-muted-foreground/70">⌘K</kbd>
        </button>
      </div>
      {groups.map(group => (
        <div key={group.label} className="px-2 py-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-2 pb-1 pt-2">{group.label}</div>
          <div className="space-y-0.5">
            {group.items.map(item => {
              const Icon = item.icon;
              const isActive = active === item.key;
              const count = counts?.[item.key];
              const badge = counts?.[item.key + "Badge"];
              return (
                <button
                  key={item.key}
                  onClick={() => onSelect(item.key)}
                  className={cn(
                    "group relative w-full flex items-center gap-2 h-8 pl-3 pr-2 rounded-md text-[13px] transition-colors text-left",
                    isActive ? "bg-background text-foreground font-medium shadow-sm border border-border" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5 flex-shrink-0", isActive ? "text-foreground" : "text-muted-foreground")} />
                  <span className="flex-1 truncate">{item.label}</span>
                  {badge && <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500" />}
                  {count !== undefined && count !== null && count !== 0 && (
                    <span className={cn(
                      "text-[10px] tabular-nums px-1.5 h-4 rounded-full inline-flex items-center justify-center",
                      isActive ? "bg-foreground text-background font-semibold" : "text-muted-foreground/80 bg-muted/60"
                    )}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex-1" />
      <div className="p-2 border-t border-border text-[10px] text-muted-foreground/60 px-3 py-2">
        Project Details V2
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tonomo flat-card panel — REPLACES the inner Tabs in TonomoTab.
// All 5 things you'd see across Review/Brief/Timeline/Audit/Raw are visible
// at once as cards; this is the "fold subtabs into cards" pattern.
function TonomoFlatPanel({ project, allProducts = [], allPackages = [], canApprove, onApprove, onFlag }) {
  const orderId = project?.tonomo_order_id;

  const { data: auditLogs = [] } = useQuery({
    queryKey: ["pdv2-tonomo-audit", orderId],
    enabled: !!orderId,
    queryFn: async () => {
      const all = await api.entities.TonomoAuditLog.list("-processed_at", 100);
      return all.filter(log => log.tonomo_order_id === orderId);
    },
  });

  const { data: bookingTimeline = [] } = useQuery({
    queryKey: ["pdv2-tonomo-timeline", orderId],
    enabled: !!orderId,
    refetchInterval: 15000,
    queryFn: async () => {
      const all = await api.entities.TonomoProcessingQueue.list("-created_date", 200);
      return all.filter(q => q.order_id === orderId);
    },
  });

  if (!orderId) {
    return <div className="border border-dashed border-border rounded-lg py-12 text-center text-xs text-muted-foreground">This project did not originate from Tonomo.</div>;
  }

  return (
    <div className="space-y-4">
      {/* Review banner — only appears when pending */}
      {project.status === "pending_review" && (
        <div className="border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-amber-900 dark:text-amber-200">Pending review — {project.pending_review_type || "new booking"}</div>
            <div className="text-[11.5px] text-amber-800/80 dark:text-amber-300/80 mt-0.5 line-clamp-2">{project.pending_review_reason || "Review and approve to continue the workflow."}</div>
          </div>
          {canApprove && (
            <div className="flex gap-2 flex-shrink-0">
              <button onClick={onFlag} className="h-8 px-3 rounded-md border border-amber-300 dark:border-amber-800 bg-background hover:bg-amber-100/50 text-[12px] font-medium text-amber-800 dark:text-amber-300">Flag</button>
              <button onClick={onApprove} className="h-8 px-3 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[12px] font-semibold">Approve</button>
            </div>
          )}
        </div>
      )}

      {/* 2-column grid: Brief | Timeline. On smaller widths stacks. */}
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        {/* Brief */}
        <Card title="Order brief" subtitle={`Tonomo ID ${project.tonomo_order_id}`} icon={Database}>
          <div className="space-y-2 text-[12.5px]">
            <BriefRow label="Property" value={project.property_address} />
            <BriefRow label="Property type" value={project.property_type || "—"} />
            <BriefRow label="Appointment" value={project.scheduled_at ? fmtTime(project.scheduled_at) : "Not scheduled"} />
            <BriefRow label="Tonomo agent" value={project.tonomo_agent_name || project.client_name || "—"} />
            <BriefRow label="Order created" value={project.tonomo_received_at ? fmtTime(project.tonomo_received_at) : "—"} />
            <BriefRow label="Source" value={project.source || "tonomo"} mono />
          </div>
        </Card>

        {/* Timeline */}
        <Card title="Booking timeline" subtitle={`${bookingTimeline.length} events`} icon={History}>
          {bookingTimeline.length === 0 ? (
            <div className="text-[12px] text-muted-foreground">No queue events yet.</div>
          ) : (
            <ol className="relative pl-5 max-h-[260px] overflow-y-auto">
              <div className="absolute top-1 bottom-1 left-1.5 w-px bg-border" />
              {bookingTimeline.slice(0, 20).map((q, i) => (
                <li key={q.id || i} className="relative py-1.5">
                  <div className="absolute -left-3 top-2.5 w-2 h-2 rounded-full bg-blue-500 ring-2 ring-background" />
                  <div className="text-[12px]">
                    <span className="font-medium">{q.action || q.event || "event"}</span>
                    <span className="text-muted-foreground"> · {q.status || "—"}</span>
                  </div>
                  <div className="text-[10.5px] text-muted-foreground tabular-nums">{q.created_at ? fmtTime(q.created_at) : "—"}</div>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {/* Audit log */}
        <Card title="Audit trail" subtitle={`${auditLogs.length} entries`} icon={Activity}>
          {auditLogs.length === 0 ? (
            <div className="text-[12px] text-muted-foreground">No audit entries yet.</div>
          ) : (
            <div className="max-h-[260px] overflow-y-auto -mx-1 px-1 space-y-1">
              {auditLogs.slice(0, 20).map((a, i) => (
                <div key={a.id || i} className="flex items-start gap-2 py-1 border-b border-border/40 last:border-b-0">
                  <Chip tone={a.action === "approved" ? "green" : a.action === "flagged" ? "red" : "blue"}>{a.action || "—"}</Chip>
                  <div className="flex-1 min-w-0 text-[12px]">
                    <div className="font-medium truncate">{a.entity_type} · {a.operation || "—"}</div>
                    <div className="text-[10.5px] text-muted-foreground tabular-nums">{a.processed_at ? fmtTime(a.processed_at) : "—"}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Raw payload */}
        <Card title="Raw payload" subtitle="Webhook source" icon={Radar}>
          <RawPayloadBlock orderId={orderId} />
        </Card>
      </div>
    </div>
  );
}

function BriefRow({ label, value, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 border-b border-border/40 last:border-b-0">
      <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground flex-shrink-0">{label}</span>
      <span className={cn("text-[12.5px] truncate text-right", mono && "font-mono")}>{value}</span>
    </div>
  );
}

function RawPayloadBlock({ orderId }) {
  const { data: raw } = useQuery({
    queryKey: ["pdv2-tonomo-raw", orderId],
    enabled: !!orderId,
    queryFn: async () => {
      const logs = await api.entities.TonomoWebhookLog.list("-received_at", 200);
      const m = logs.find(log => {
        try {
          const p = JSON.parse(log.raw_payload || "{}");
          return p.orderId === orderId || p.order?.orderId === orderId;
        } catch { return false; }
      });
      return m?.raw_payload || null;
    },
  });
  if (!raw) return <div className="text-[12px] text-muted-foreground">No raw payload found.</div>;
  let pretty = raw;
  try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
  return (
    <pre className="text-[10.5px] font-mono leading-relaxed bg-muted/40 rounded p-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words">{pretty}</pre>
  );
}

function Card({ title, subtitle, icon: Icon, children, className }) {
  return (
    <div className={cn("border border-border rounded-lg bg-background overflow-hidden", className)}>
      <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-border bg-muted/20">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
          <h3 className="text-[12.5px] font-semibold tracking-tight truncate">{title}</h3>
        </div>
        {subtitle && <span className="text-[10.5px] text-muted-foreground tabular-nums">{subtitle}</span>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notes panel — first-class, no longer split between Pricing card + Activity Hub
function NotesPanel({ projectId }) {
  const { data: notes = [], isLoading } = useQuery({
    queryKey: ["pdv2-notes", projectId],
    enabled: !!projectId,
    queryFn: () => api.entities.OrgNote.filter({ project_id: projectId }, "-created_at", 100).then(r => r || []),
  });
  if (isLoading) return <CanvasFallback label="Loading notes…" />;
  if (notes.length === 0) {
    return (
      <div className="border border-dashed border-border rounded-lg py-12 text-center">
        <MessageSquare className="h-6 w-6 mx-auto mb-2 text-muted-foreground/50" />
        <div className="text-sm font-medium text-foreground">No notes yet</div>
        <p className="text-xs text-muted-foreground mt-0.5">Use the composer in the activity timeline below to add the first note.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {notes.map(n => (
        <div key={n.id} className="border border-border rounded-lg p-3 bg-background hover:bg-muted/20 transition-colors">
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[12.5px] font-medium truncate">{n.author_name || n.user_name || "Unknown"}</span>
              {n.link_kind && <Chip tone={n.link_kind === "email" ? "green" : n.link_kind === "task" ? "amber" : "violet"}>{n.link_kind}</Chip>}
              {n.is_pinned && <Chip tone="amber"><Star className="h-2.5 w-2.5" />Pinned</Chip>}
            </div>
            <span className="text-[10.5px] text-muted-foreground tabular-nums flex-shrink-0">{fmtTime(n.created_at)}</span>
          </div>
          <div className="text-[12.5px] leading-relaxed text-foreground/90 whitespace-pre-wrap line-clamp-6">
            {n.body || n.content || ""}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Rail
function ContextRail({ project, agent, agency, displayPrice, projectId, currentUser, canSeePricing, onEditAgent, productsData, packagesData }) {
  const shootDate = project?.scheduled_at || project?.shoot_date;
  const shootDateStr = shootDate ? new Date(shootDate).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : "Not scheduled";
  const shootTimeStr = shootDate ? new Date(shootDate).toLocaleString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }) : "";

  const services = useMemo(() => {
    const list = [];
    if (Array.isArray(project?.services_summary)) return project.services_summary;
    (project?.products || []).forEach(p => {
      const def = (productsData || []).find(d => d.id === (p.product_id || p));
      if (def) list.push(def.name);
    });
    (project?.packages || []).forEach(p => {
      const def = (packagesData || []).find(d => d.id === (p.package_id || p));
      if (def) list.push(def.name);
    });
    return list;
  }, [project?.products, project?.packages, project?.services_summary, productsData, packagesData]);

  const tier = project?.pricing_tier || project?.tier;
  const balance = (Number(displayPrice) || 0) - (Number(project?.invoiced_amount) || 0);

  return (
    <aside className="hidden xl:flex flex-col w-[320px] 2xl:w-[360px] flex-shrink-0 border-l border-border bg-background overflow-y-auto sticky top-[104px] max-h-[calc(100vh-104px)]">
      <Section title="People" defaultOpen summary={agent ? `${agent.name}${agency ? ` · ${agency.name}` : ''}` : undefined}>
        {agent ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-100 to-violet-100 dark:from-blue-950/40 dark:to-violet-950/40 flex items-center justify-center text-[13px] font-semibold text-blue-700 dark:text-blue-300 flex-shrink-0 ring-1 ring-border/40">
                {(agent.name || "?")[0]?.toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate leading-tight">{agent.name}</div>
                {agency && (
                  <Link to={createPageUrl(`OrgDetails?id=${agency.id}`)} className="text-[11px] text-muted-foreground hover:text-foreground truncate inline-flex items-center gap-1 leading-tight">
                    <Building2 className="h-2.5 w-2.5" /> {agency.name}
                  </Link>
                )}
              </div>
              <button onClick={onEditAgent} className="h-6 w-6 rounded-md hover:bg-muted text-muted-foreground flex-shrink-0 inline-flex items-center justify-center" title="Change agent"><Edit3 className="h-3 w-3" /></button>
            </div>
            <div className="grid grid-cols-1 gap-1">
              {agent.email && (
                <a href={`mailto:${agent.email}`} className="inline-flex items-center gap-2 h-7 px-2 rounded-md hover:bg-muted/60 text-[12px] text-foreground transition-colors min-w-0">
                  <Mail className="h-3 w-3 text-muted-foreground flex-shrink-0" /><span className="truncate">{agent.email}</span>
                </a>
              )}
              {agent.phone && (
                <a href={`tel:${agent.phone}`} className="inline-flex items-center gap-2 h-7 px-2 rounded-md hover:bg-muted/60 text-[12px] text-foreground transition-colors">
                  <Phone className="h-3 w-3 text-muted-foreground flex-shrink-0" /><span className="tabular-nums">{agent.phone}</span>
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-muted-foreground italic">No agent assigned</div>
        )}
      </Section>

      {canSeePricing && (
        <Section title="Pricing" defaultOpen summary={`${fmtMoney(displayPrice)} · ${project?.payment_status === "paid" ? "Paid" : "Unpaid"}`}>
          <div className="space-y-3">
            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Total</div>
                <div className="text-[20px] font-bold tabular-nums leading-none mt-0.5">{fmtMoney(displayPrice)}</div>
              </div>
              <Chip tone={project?.payment_status === "paid" ? "green" : "amber"}>
                <CreditCard className="h-2.5 w-2.5" />{project?.payment_status === "paid" ? "Paid" : "Unpaid"}
              </Chip>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <div className="text-muted-foreground">Invoiced</div>
                <div className="font-medium tabular-nums">{fmtMoney(project?.invoiced_amount)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Outstanding</div>
                <div className={cn("font-medium tabular-nums", balance > 0 && "text-amber-600 dark:text-amber-400")}>{fmtMoney(balance)}</div>
              </div>
            </div>
            {project?.matrix_state?.matrix_name && (
              <div className="flex items-center justify-between text-[11px] pt-2 border-t border-border/60">
                <span className="text-muted-foreground">Matrix</span>
                <span className="text-foreground/90 truncate max-w-[60%] text-right">{project.matrix_state.matrix_name}</span>
              </div>
            )}
            {Array.isArray(services) && services.length > 0 && (
              <div className="pt-1 flex flex-wrap gap-1">
                {services.slice(0, 8).map((s, i) => (
                  <span key={i} className="inline-flex items-center h-5 px-1.5 rounded bg-muted/60 text-[10.5px] text-foreground/80">
                    {typeof s === "string" ? s : s.name || s.product_name || "Item"}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="Schedule" defaultOpen summary={`${shootDateStr}${shootTimeStr ? ' · ' + shootTimeStr : ''}`}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-md bg-muted/60 flex items-center justify-center flex-shrink-0">
              <CloudSun className="h-4 w-4 text-amber-500" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium leading-tight">{shootDateStr}</div>
              <div className="text-[11px] text-muted-foreground tabular-nums">{shootTimeStr || "—"}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {tier && <Chip tone="violet"><Sparkles className="h-2.5 w-2.5" />{String(tier)}</Chip>}
            {project?.is_twilight && <Chip tone="amber">🌅 Twilight</Chip>}
            {project?.calendar_auto_linked && <Chip tone="blue"><Zap className="h-2.5 w-2.5" />Auto-linked</Chip>}
          </div>
        </div>
      </Section>

      <Section title="Staff" defaultOpen>
        <div className="-mx-1">
          <Suspense fallback={<div className="text-[11px] text-muted-foreground">Loading…</div>}>
            <ProjectStaffBar project={project} />
          </Suspense>
        </div>
      </Section>

      <Section title="Property" defaultOpen={false} summary={project?.property_address || "—"}>
        <div className="text-[12px] space-y-2">
          <div className="text-muted-foreground leading-snug">{project?.property_address || "—"}</div>
          {project?.property_id && (
            <Link to={createPageUrl(`PropertyDetails?id=${project.property_id}`)} className="inline-flex items-center gap-1 text-foreground hover:underline">
              <ExternalLink className="h-3 w-3" />Open property record
            </Link>
          )}
          {project?.confirmed_lat && project?.confirmed_lng && (
            <Chip tone="green"><MapPin className="h-2.5 w-2.5" />Pinned</Chip>
          )}
        </div>
      </Section>

      <Section title="Audit" defaultOpen={false} summary={project?.updated_at ? `Updated ${fmtTime(project.updated_at)}` : ''}>
        <div className="text-[11px] text-muted-foreground space-y-1">
          {project?.created_at && <div>Created: <span className="text-foreground/80">{fmtTime(project.created_at)}</span></div>}
          {project?.updated_at && <div>Updated: <span className="text-foreground/80">{fmtTime(project.updated_at)}</span></div>}
          {project?.last_status_change && <div>Last stage change: <span className="text-foreground/80">{fmtTime(project.last_status_change)}</span></div>}
        </div>
      </Section>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
export default function ProjectDetailsV2() {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("id");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── Auth & permissions ─────────────────────────────────────────────────────
  const { data: currentUser } = useCurrentUser();
  const { canSeePricing, canEditProject, isEmployeeOrAbove } = usePermissions();
  const { canEdit: entityCanEdit, canView: entityCanView } = useEntityAccess("projects");

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: projectRaw, loading: isLoading } = useSmartEntityData("Project", projectId, { priority: 10 });
  // Stable ref so brief cache flickers don't unmount the page
  const projectStableRef = useRef(null);
  if (projectRaw) projectStableRef.current = projectRaw;
  const project = projectRaw || projectStableRef.current;
  const projectRef = useRef(project); projectRef.current = project;

  const { data: agent } = useSmartEntityData("Agent", project?.agent_id, { priority: 5 });
  const effectiveAgencyId = project?.agency_id || agent?.current_agency_id || null;
  const { data: agency } = useSmartEntityData("Agency", effectiveAgencyId, { priority: 5 });
  const { data: productsData = [] } = useSmartEntityList("Product");
  const { data: packagesData = [] } = useSmartEntityList("Package");
  const { tasks: projectTasks = [] } = useProjectTasks(projectId);

  // Sub-set of activity for command-rail / banners (full hub renders below)
  const { data: bannerActivities = [] } = useQuery({
    queryKey: ["pdv2-banner-activity", projectId],
    enabled: Boolean(projectId),
    staleTime: 60_000,
    queryFn: () => api.entities.ProjectActivity.filter({ project_id: projectId }, "-created_at", 50).then(r => r || []),
  });

  // Drone work gating (do we show Drones section in workbench?)
  const { data: hasDroneWorkRows = [] } = useQuery({
    queryKey: ["pdv2-drone-shoots", projectId],
    enabled: Boolean(projectId),
    staleTime: 60_000,
    queryFn: () => api.entities.DroneShoot.filter({ project_id: projectId }, "-flight_started_at", 1).then(r => r || []),
  });
  const hasDroneShoots = hasDroneWorkRows.length > 0;
  const hasDroneCategoryItem = useMemo(() => {
    const productIds = (project?.products || []).map(p => p.product_id || p);
    const packageIds = (project?.packages || []).map(p => p.package_id || p);
    const droneCats = ["drone", "drone_video", "aerial"];
    if (productIds.some(id => productsData.find(p => p.id === id && droneCats.includes(p.category)))) return true;
    if (packageIds.some(id => packagesData.find(p => p.id === id && (p.products || []).some(pp => droneCats.includes(productsData.find(d => d.id === (pp.product_id || pp))?.category))))) return true;
    return false;
  }, [project?.products, project?.packages, productsData, packagesData]);
  const hasDroneWork = hasDroneShoots || hasDroneCategoryItem;
  const isTonomoProject = !!project?.tonomo_order_id || project?.source === "tonomo";

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeSection, setActiveSection] = useState(() => {
    const s = searchParams.get("section");
    return SECTION_KEYS.includes(s) ? s : "tasks";
  });
  const handleSectionChange = useCallback((s) => {
    setActiveSection(s);
    const params = new URLSearchParams(window.location.search);
    if (s === "tasks") params.delete("section"); else params.set("section", s);
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? "?" + qs : ""}`);
  }, []);

  const [showEditForm, setShowEditForm] = useState(false);
  const [composeAgent, setComposeAgent] = useState(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ── Mutations (mirror V1) ──────────────────────────────────────────────────
  const updateStatusMutation = useMutation({
    onMutate: (newStatus) => {
      const p = projectRef.current; if (!p) return;
      const prev = { status: p.status, last_status_change: p.last_status_change };
      const optimistic = { status: newStatus, last_status_change: new Date().toISOString() };
      if (newStatus === "onsite" && !p.shooting_started_at) optimistic.shooting_started_at = new Date().toISOString();
      updateEntityInCache("Project", projectId, optimistic);
      return { prev };
    },
    mutationFn: async (newStatus) => {
      const p = projectRef.current;
      const updateData = { status: newStatus, last_status_change: new Date().toISOString() };
      if (newStatus === "onsite" && !p.shooting_started_at) updateData.shooting_started_at = new Date().toISOString();
      await api.entities.Project.update(projectId, updateData);
      api.functions.invoke("trackProjectStageChange", {
        projectId, old_data: { status: p.status }, data: { ...p, status: newStatus },
        actor_id: currentUser?.id, actor_name: currentUser?.full_name,
      }).catch(() => {});
      api.functions.invoke("calculateProjectTaskDeadlines", {
        project_id: projectId, trigger_event: `status_${newStatus}`,
      }).then(() => queryClient.invalidateQueries({ queryKey: ["project-tasks-scoped", projectId] })).catch(() => {});
      writeFeedEvent({
        eventType: "project_stage_changed", category: "project", severity: "info",
        actorId: currentUser?.id, actorName: currentUser?.full_name,
        title: `Stage → ${stageLabel(newStatus)}`,
        description: `${p.title || p.property_address} moved from ${stageLabel(p.status)} to ${stageLabel(newStatus)}`,
        projectId, projectName: p.title || p.property_address,
        projectStage: newStatus, entityType: "project", entityId: projectId,
      }).catch(() => {});
      toast.success(`Stage → ${stageLabel(newStatus)}`);
    },
    onError: (err, newStatus, ctx) => {
      if (ctx?.prev) updateEntityInCache("Project", projectId, ctx.prev);
      toast.error(err?.message || "Failed to change stage");
    },
    onSettled: () => invalidateProjectCaches(queryClient, { project: true }),
  });

  const updatePaymentMutation = useMutation({
    onMutate: (newStatus) => {
      const p = projectRef.current; if (!p) return;
      const prev = { payment_status: p.payment_status };
      updateEntityInCache("Project", projectId, { payment_status: newStatus });
      return { prev };
    },
    mutationFn: (newStatus) => api.entities.Project.update(projectId, { payment_status: newStatus }),
    onError: (e, _, ctx) => { if (ctx?.prev) updateEntityInCache("Project", projectId, ctx.prev); toast.error("Failed"); },
    onSuccess: (_, newStatus) => toast.success(newStatus === "paid" ? "Marked paid" : "Marked unpaid"),
  });

  const archiveMutation = useMutation({
    mutationFn: () => api.entities.Project.update(projectId, { is_archived: !project.is_archived }),
    onSuccess: () => {
      toast.success(project.is_archived ? "Project unarchived" : "Project archived");
      invalidateProjectCaches(queryClient, { project: true });
    },
    onError: (e) => toast.error(e?.message || "Failed"),
  });

  const tonomoApproveMutation = useMutation({
    mutationFn: async () => {
      const p = projectRef.current;
      const fallback = p.shoot_date ? "scheduled" : "to_be_scheduled";
      const newStatus = p.pre_revision_stage || fallback;
      await api.entities.Project.update(projectId, {
        status: newStatus, pending_review_reason: null, pending_review_type: null,
        pre_revision_stage: null, urgent_review: false, auto_approved: false,
      });
    },
    onSuccess: () => { toast.success("Approved"); invalidateProjectCaches(queryClient, { project: true }); },
    onError: (e) => toast.error(e?.message || "Failed to approve"),
  });

  const tonomoFlagMutation = useMutation({
    mutationFn: async () => {
      const p = projectRef.current;
      const reason = window.prompt("Reason for flagging?");
      if (!reason) return;
      await api.entities.Project.update(projectId, {
        flagged: true, flagged_reason: reason, flagged_by: currentUser?.full_name,
        flagged_at: new Date().toISOString(),
      });
    },
    onSuccess: () => { toast.success("Flagged"); invalidateProjectCaches(queryClient, { project: true }); },
  });

  // ── Derived ────────────────────────────────────────────────────────────────
  const displayPrice = project?.calculated_price || project?.price || 0;
  const paymentTone = project?.payment_status === "paid" ? "green" : "amber";
  const paymentLabel = project?.payment_status === "paid" ? "Paid" : "Unpaid";
  const memoizedCanEdit = useMemo(() => canEditProject(project), [canEditProject, project]);

  const counts = useMemo(() => {
    const active = (projectTasks || []).filter(t => !t.is_deleted && !t.is_archived);
    const dueSoon = active.filter(t => !t.is_completed && t.deadline && new Date(t.deadline) < new Date(Date.now() + 24 * 3600 * 1000));
    return {
      tasks: active.length || null,
      tasksBadge: dueSoon.length > 0,
    };
  }, [projectTasks]);

  // Context-aware primary action
  const { primary, primaryFn } = useMemo(() => {
    if (!project) return {};
    if (project.status === "pending_review") return {
      primary: "Approve",
      primaryFn: () => tonomoApproveMutation.mutate(),
    };
    if (project.status === "delivered" && project.payment_status !== "paid") return {
      primary: "Mark as paid",
      primaryFn: () => updatePaymentMutation.mutate("paid"),
    };
    if (project.status === "in_revision") return {
      primary: "Mark delivered",
      primaryFn: () => updateStatusMutation.mutate("delivered"),
    };
    const idx = STAGE_ORDER.indexOf(project.status);
    if (idx >= 0 && idx < STAGE_ORDER.length - 1) {
      const next = STAGE_ORDER[idx + 1];
      return {
        primary: `Move to ${stageLabel(next)}`,
        primaryFn: () => updateStatusMutation.mutate(next),
      };
    }
    return {};
  }, [project, updateStatusMutation, updatePaymentMutation, tonomoApproveMutation]);

  // ── Stage transition gate (backward → confirm) ─────────────────────────────
  const handleStageChange = useCallback((newStage) => {
    const p = projectRef.current; if (!p) return;
    if (newStage === p.status) return;
    const oldIdx = STAGE_ORDER.indexOf(p.status);
    const newIdx = STAGE_ORDER.indexOf(newStage);
    if (newIdx < oldIdx) {
      if (!window.confirm(`Move backwards from ${stageLabel(p.status)} to ${stageLabel(newStage)}?`)) return;
    }
    updateStatusMutation.mutate(newStage);
  }, [updateStatusMutation]);

  // ── Section content ────────────────────────────────────────────────────────
  const sectionContent = useMemo(() => {
    if (!project) return null;
    switch (activeSection) {
      case "tasks":
        return (
          <Suspense fallback={<CanvasFallback label="Loading tasks…" />}>
            <TaskManagement project={project} canEdit={memoizedCanEdit} />
          </Suspense>
        );
      case "requests":
        return (
          <Suspense fallback={<CanvasFallback label="Loading requests…" />}>
            <ProjectRevisionsTab projectId={projectId} project={project} canEdit={memoizedCanEdit} />
          </Suspense>
        );
      case "effort":
        return (
          <Suspense fallback={<CanvasFallback label="Loading effort…" />}>
            <EffortLoggingTab projectId={projectId} project={project} />
          </Suspense>
        );
      case "notes":
        return <NotesPanel projectId={projectId} />;
      case "media":
        return (
          <Suspense fallback={<CanvasFallback label="Loading media…" />}>
            <ProjectMediaGallery project={project} />
          </Suspense>
        );
      case "files":
        return (
          <Suspense fallback={<CanvasFallback label="Loading files…" />}>
            <ProjectFilesTab project={project} />
          </Suspense>
        );
      case "drones":
        return (
          <Suspense fallback={<CanvasFallback label="Loading drones…" />}>
            <ProjectDronesTab project={project} />
          </Suspense>
        );
      case "tonomo":
        return (
          <TonomoFlatPanel
            project={project}
            allProducts={productsData}
            allPackages={packagesData}
            canApprove={memoizedCanEdit}
            onApprove={() => tonomoApproveMutation.mutate()}
            onFlag={() => tonomoFlagMutation.mutate()}
          />
        );
      case "shortlisting":
        return (
          <Suspense fallback={<CanvasFallback label="Loading shortlisting…" />}>
            <ProjectShortlistingTab project={project} />
          </Suspense>
        );
      default:
        return null;
    }
  }, [activeSection, project, projectId, memoizedCanEdit, productsData, packagesData, tonomoApproveMutation, tonomoFlagMutation]);

  // ── Loading / not found ────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) navigate(createPageUrl("Projects"));
  }, [projectId, navigate]);

  if (!projectId) return null;

  if (isLoading && !project) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xs text-muted-foreground inline-flex items-center gap-2">
          <div className="w-3 h-3 rounded-full border-2 border-border border-t-foreground animate-spin" />Loading project…
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-sm text-muted-foreground">Project not found.</div>
      </div>
    );
  }

  if (!entityCanView) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-6 max-w-md text-center">
          <AlertTriangle className="h-8 w-8 text-rose-500 mx-auto mb-2" />
          <h2 className="text-base font-semibold text-rose-900">Access denied</h2>
          <p className="text-sm text-rose-700 mt-1">You don't have permission to view this project.</p>
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col w-full -m-4 lg:-m-6">
      {/* Validation banner — full width */}
      <Suspense fallback={null}>
        {project && <ProjectValidationBanner project={project} canEdit={memoizedCanEdit} onEditClick={() => setShowEditForm(true)} />}
      </Suspense>

      {/* Concurrent edit detector (no UI by default; prompts on conflict) */}
      <Suspense fallback={null}>
        {project && <ConcurrentEditDetector project={project} onRefresh={() => window.location.reload()} />}
      </Suspense>

      <CommandRail
        project={project}
        projectId={projectId}
        agent={agent}
        agency={agency}
        paymentTone={paymentTone}
        paymentLabel={paymentLabel}
        primaryAction={primary}
        onPrimaryAction={primaryFn}
        onEdit={() => setShowEditForm(true)}
        onArchive={() => archiveMutation.mutate()}
        onEmailAgent={() => agent && setComposeAgent(agent)}
        currentUser={currentUser}
      />

      <StageStrip status={project.status} onChange={handleStageChange} lastChange={project.last_status_change || project.updated_at} isPending={updateStatusMutation.isPending} />

      <div className="flex flex-1 min-h-0">
        <Workbench
          active={activeSection}
          onSelect={handleSectionChange}
          counts={counts}
          hasDroneWork={hasDroneWork}
          isTonomoProject={isTonomoProject}
          isEmployeeOrAbove={isEmployeeOrAbove}
          onCommandPalette={() => setPaletteOpen(true)}
        />

        <main className="flex-1 min-w-0 flex flex-col bg-muted/[0.03]">
          {/* KPI strip */}
          <div className="px-5 lg:px-6 py-3 border-b border-border bg-background flex items-center gap-6 flex-wrap">
            <KpiStat label="Tasks" value={`${(projectTasks || []).filter(t => t.is_completed).length}/${(projectTasks || []).filter(t => !t.is_deleted && !t.is_archived).length}`} progress={(projectTasks || []).filter(t => t.is_completed).length / Math.max(1, (projectTasks || []).filter(t => !t.is_deleted && !t.is_archived).length)} tone="blue" />
            <KpiStat label="Activity" value={`${bannerActivities.length}`} sub="recent events" tone="violet" />
            {project.last_status_change && (
              <KpiStat label="In stage" value={formatDuration(Date.now() - new Date(project.last_status_change).getTime())} tone="amber" />
            )}
            {project.created_at && (
              <KpiStat label="Project age" value={formatDuration(Date.now() - new Date(project.created_at).getTime())} tone="neutral" />
            )}
            {project.payment_status !== "paid" && Number(displayPrice) > 0 && (
              <KpiStat label="Outstanding" value={fmtMoney((Number(displayPrice) || 0) - (Number(project.invoiced_amount) || 0))} tone="red" />
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              {project && (
                <Suspense fallback={null}>
                  <ProjectHealthIndicator project={project} tasks={projectTasks} />
                </Suspense>
              )}
            </div>
          </div>

          {/* Section header */}
          <div className="px-5 lg:px-6 pt-4 pb-2 flex items-center justify-between border-b border-border/40">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[15px] font-semibold tracking-tight capitalize">{activeSection}</h2>
              <span className="text-[11px] text-muted-foreground">{sectionSubtitle(activeSection, projectTasks)}</span>
            </div>
            <div className="flex items-center gap-1">
              <a
                href={createPageUrl(`ProjectDetails?id=${projectId}&tab=${activeSection}`)}
                className="text-[10.5px] uppercase tracking-wide text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 h-6 rounded hover:bg-muted"
                title="Open this section in V1 layout"
              >
                Open in V1<ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          </div>

          {/* Section content */}
          <div className="px-5 lg:px-6 py-4 flex-1">
            {sectionContent}
          </div>

          {/* Activity timeline — full ProjectActivityHub at the bottom of every section */}
          <div className="border-t border-border bg-background">
            <Suspense fallback={<div className="px-5 py-4 text-xs text-muted-foreground">Loading activity…</div>}>
              <ProjectActivityHub project={project} />
            </Suspense>
          </div>
        </main>

        <ContextRail
          project={project}
          agent={agent}
          agency={agency}
          displayPrice={displayPrice}
          projectId={projectId}
          currentUser={currentUser}
          canSeePricing={canSeePricing}
          onEditAgent={() => toast.info("Agent selector — wire from V1 in next pass")}
          productsData={productsData}
          packagesData={packagesData}
        />
      </div>

      {/* Dialogs */}
      {showEditForm && project && (
        <Suspense fallback={null}>
          <ProjectForm
            project={project}
            onClose={() => setShowEditForm(false)}
            onSave={() => { setShowEditForm(false); invalidateProjectCaches(queryClient, { project: true }); }}
          />
        </Suspense>
      )}

      {composeAgent && (
        <Suspense fallback={null}>
          <EmailComposeDialog
            isOpen={!!composeAgent}
            onClose={() => setComposeAgent(null)}
            recipientAgent={composeAgent}
            project={project}
          />
        </Suspense>
      )}

      {/* Command palette */}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          actions={[
            { id: "edit", label: "Edit project", icon: Edit3, onSelect: () => setShowEditForm(true) },
            { id: "archive", label: project.is_archived ? "Unarchive project" : "Archive project", icon: Archive, onSelect: () => archiveMutation.mutate() },
            { id: "email", label: "Email agent", icon: Mail, disabled: !agent?.email, onSelect: () => agent && setComposeAgent(agent) },
            { id: "copy", label: "Copy link", icon: Copy, onSelect: () => { navigator.clipboard.writeText(window.location.href); toast.success("URL copied"); } },
            { id: "address", label: "Copy address", icon: MapPin, onSelect: () => { if (project.property_address) { navigator.clipboard.writeText(project.property_address); toast.success("Address copied"); } } },
            { id: "v1", label: "Open in V1 layout", icon: ExternalLink, onSelect: () => navigate(createPageUrl(`ProjectDetails?id=${projectId}`)) },
            ...(project.payment_status !== "paid" ? [{ id: "pay", label: "Mark as paid", icon: CreditCard, onSelect: () => updatePaymentMutation.mutate("paid") }] : []),
            ...(project.payment_status === "paid" ? [{ id: "unpay", label: "Mark as unpaid", icon: CreditCard, onSelect: () => updatePaymentMutation.mutate("unpaid") }] : []),
            ...STAGE_ORDER.map(s => ({ id: `stage-${s}`, label: `Move to ${stageLabel(s)}`, icon: ChevronRight, disabled: s === project.status, onSelect: () => handleStageChange(s) })),
          ]}
        />
      )}
    </div>
  );
}

function sectionSubtitle(s, tasks = []) {
  switch (s) {
    case "tasks": {
      const open = tasks.filter(t => !t.is_completed && !t.is_deleted && !t.is_archived).length;
      const done = tasks.filter(t => t.is_completed).length;
      return `${open} open · ${done} done`;
    }
    case "requests": return "Client revision requests";
    case "effort": return "Time logged across the project";
    case "notes": return "Internal notes — composer is in the activity timeline";
    case "media": return "Photos, videos, drone shots";
    case "files": return "Final deliverables and project files";
    case "drones": return "Drone shoots, SfM runs, renders";
    case "tonomo": return "Tonomo order brief, timeline, and audit (no inner tabs)";
    case "shortlisting": return "Shortlisting rounds, coverage, retouch";
    default: return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command palette (⌘K)
function CommandPalette({ onClose, actions }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(a => a.label.toLowerCase().includes(q));
  }, [actions, query]);
  const inputRef = useRef(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 pt-[15vh] animate-in fade-in duration-150" onClick={onClose}>
      <div className="w-full max-w-lg bg-background border border-border rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 h-12 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Type a command…"
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60" />
          <kbd className="text-[10px] tabular-nums px-1.5 py-0.5 rounded border border-border text-muted-foreground/70">esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="text-center text-xs text-muted-foreground py-6">No matches</div>
          ) : (
            filtered.map((a, i) => {
              const Icon = a.icon || ChevronRight;
              return (
                <button
                  key={a.id || i}
                  disabled={a.disabled}
                  onClick={() => { if (a.disabled) return; a.onSelect?.(); onClose(); }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 h-9 text-left text-[13px] transition-colors",
                    a.disabled ? "text-muted-foreground/40 cursor-not-allowed" : "hover:bg-muted text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{a.label}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

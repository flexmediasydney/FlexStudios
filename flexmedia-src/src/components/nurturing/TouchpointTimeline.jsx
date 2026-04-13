import { useMemo, useRef, useEffect } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fmtDate, fixTimestamp, formatRelative } from "@/components/utils/dateUtils";
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Voicemail,
  Mail,
  MessageCircle,
  MessageSquare,
  Image,
  Video,
  Footprints,
  Home,
  FileText,
  Gift,
  Briefcase,
  Presentation,
  MapPin,
  PhoneCall,
  Plus,
  Clock,
  BarChart3,
  Hash,
  CalendarDays,
  Facebook,
  Instagram,
  Linkedin,
} from "lucide-react";

const ICON_MAP = {
  PhoneOutgoing,
  PhoneIncoming,
  Voicemail,
  Mail,
  MessageCircle,
  MessageSquare,
  Image,
  Video,
  Footprints,
  Home,
  FileText,
  Gift,
  Briefcase,
  Presentation,
  MapPin,
  PhoneCall,
  Facebook,
  Instagram,
  Linkedin,
};

const OUTCOME_COLORS = {
  positive:    { bg: "bg-green-500",  border: "border-green-500",  ring: "ring-green-200" },
  neutral:     { bg: "bg-amber-500",  border: "border-amber-500",  ring: "ring-amber-200" },
  negative:    { bg: "bg-red-500",    border: "border-red-500",    ring: "ring-red-200" },
  no_response: { bg: "bg-gray-400",   border: "border-gray-400",   ring: "ring-gray-200" },
};

const OUTCOME_BADGE = {
  positive:    { label: "Positive",    variant: "success" },
  neutral:     { label: "Neutral",     className: "bg-amber-100 text-amber-800 border-transparent" },
  negative:    { label: "Negative",    variant: "destructive" },
  no_response: { label: "No Response", variant: "secondary" },
};

const SENTIMENT_BADGE = {
  positive: { label: "Positive", className: "bg-green-50 text-green-700 border-green-200" },
  neutral:  { label: "Neutral",  className: "bg-gray-50 text-gray-700 border-gray-200" },
  negative: { label: "Negative", className: "bg-red-50 text-red-700 border-red-200" },
};

function getTimeGapLabel(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const a = new Date(fixTimestamp(dateA));
  const b = new Date(fixTimestamp(dateB));
  const diffMs = Math.abs(b - a);
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "same day";
  if (diffDays === 1) return "1 day";
  if (diffDays < 7) return `${diffDays} days`;
  const diffWeeks = Math.round(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w`;
  const diffMonths = Math.round(diffDays / 30);
  return `${diffMonths}mo`;
}

/**
 * TouchpointTimeline - horizontal Pipedrive-inspired timeline for all touchpoints on an entity.
 *
 * Props:
 *   entityType      — 'agent' | 'agency'
 *   entityId        — UUID string
 *   entityLabel     — display name for the entity
 *   onLogTouchpoint — callback to open the log touchpoint dialog
 */
export default function TouchpointTimeline({ entityType, entityId, entityLabel, onLogTouchpoint }) {
  const { data: allTouchpoints = [], loading: loadingTp } = useEntityList("Touchpoint", "-logged_at");
  const { data: touchpointTypes = [] } = useEntityList("TouchpointType", "sort_order");
  const scrollRef = useRef(null);

  // Filter to this entity
  const touchpoints = useMemo(() => {
    if (!entityId) return [];
    return allTouchpoints.filter(t =>
      entityType === "agent" ? t.agent_id === entityId : t.agency_id === entityId
    );
  }, [allTouchpoints, entityType, entityId]);

  // Sort chronologically for the timeline (oldest first)
  const sorted = useMemo(() => {
    return [...touchpoints].sort((a, b) => {
      const da = new Date(fixTimestamp(a.logged_at || a.created_date));
      const db = new Date(fixTimestamp(b.logged_at || b.created_date));
      return da - db;
    });
  }, [touchpoints]);

  // Build a type lookup
  const typeMap = useMemo(() => {
    const m = {};
    touchpointTypes.forEach(t => { m[t.id] = t; });
    return m;
  }, [touchpointTypes]);

  // Stats
  const stats = useMemo(() => {
    if (sorted.length === 0) return null;

    const completed = sorted.filter(t => !t.is_planned || t.completed_at);
    const lastCompleted = completed.length > 0
      ? completed[completed.length - 1]
      : null;

    const planned = sorted.filter(t => t.is_planned && !t.completed_at && t.follow_up_date);
    const nextFollowUp = planned.length > 0
      ? planned.sort((a, b) => new Date(fixTimestamp(a.follow_up_date)) - new Date(fixTimestamp(b.follow_up_date)))[0]
      : null;

    // Most used channel
    const channelCount = {};
    completed.forEach(t => {
      const tp = typeMap[t.touchpoint_type_id];
      const name = tp?.name || "Unknown";
      channelCount[name] = (channelCount[name] || 0) + 1;
    });
    const topChannel = Object.entries(channelCount).sort((a, b) => b[1] - a[1])[0];

    return {
      total: touchpoints.length,
      lastDate: lastCompleted?.logged_at || lastCompleted?.created_date,
      nextFollowUp: nextFollowUp?.follow_up_date,
      topChannel: topChannel ? topChannel[0] : null,
    };
  }, [sorted, touchpoints, typeMap]);

  // Auto-scroll timeline to the right (most recent) on load
  useEffect(() => {
    if (scrollRef.current && sorted.length > 0) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [sorted.length]);

  function getTypeIcon(tp) {
    const tpType = typeMap[tp.touchpoint_type_id];
    const iconName = tpType?.icon_name;
    const Icon = iconName && ICON_MAP[iconName] ? ICON_MAP[iconName] : Phone;
    return Icon;
  }

  function getTypeName(tp) {
    return typeMap[tp.touchpoint_type_id]?.name || "Touchpoint";
  }

  const isPlannedFuture = (tp) => tp.is_planned && !tp.completed_at;

  // ── Loading state ──
  if (loadingTp) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-28" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4].map(i => (
            <Skeleton key={i} className="h-12 w-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  // ── Empty state ──
  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Touchpoint Timeline</h3>
          {onLogTouchpoint && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onLogTouchpoint}>
              <Plus className="h-3 w-3" /> Log Touchpoint
            </Button>
          )}
        </div>
        <div className="py-8">
          <Clock className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            No touchpoints recorded yet.
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Start logging interactions to build the timeline.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Touchpoint Timeline</h3>
        {onLogTouchpoint && (
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onLogTouchpoint}>
            <Plus className="h-3 w-3" /> Log Touchpoint
          </Button>
        )}
      </div>

      {/* ── Stats row ── */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          <StatPill icon={Hash} label="Total" value={stats.total} />
          <StatPill
            icon={CalendarDays}
            label="Last"
            value={stats.lastDate ? fmtDate(stats.lastDate, "d MMM") : "--"}
          />
          <StatPill
            icon={Clock}
            label="Next"
            value={stats.nextFollowUp ? fmtDate(stats.nextFollowUp, "d MMM") : "--"}
          />
          {stats.topChannel && (
            <StatPill icon={BarChart3} label="Top Channel" value={stats.topChannel} />
          )}
        </div>
      )}

      {/* ── Horizontal Timeline ── */}
      <div
        ref={scrollRef}
        className="overflow-x-auto pb-2 scrollbar-thin"
      >
        <div className="flex items-center min-w-max px-2 py-4">
          {sorted.map((tp, idx) => {
            const Icon = getTypeIcon(tp);
            const planned = isPlannedFuture(tp);
            const outcome = tp.outcome || "no_response";
            const colors = OUTCOME_COLORS[outcome] || OUTCOME_COLORS.no_response;
            const tpDate = tp.logged_at || tp.follow_up_date || tp.created_date;
            const prevTp = idx > 0 ? sorted[idx - 1] : null;
            const prevDate = prevTp ? (prevTp.logged_at || prevTp.follow_up_date || prevTp.created_date) : null;
            const gap = prevDate ? getTimeGapLabel(prevDate, tpDate) : null;

            return (
              <div key={tp.id} className="flex items-center">
                {/* ── Connecting line + gap label ── */}
                {idx > 0 && (
                  <div className="flex flex-col items-center mx-1">
                    <div className={cn(
                      "h-0.5 w-10",
                      planned ? "border-t border-dashed border-gray-300" : "bg-gray-300"
                    )} />
                    {gap && (
                      <span className="text-[9px] text-muted-foreground/60 mt-0.5 whitespace-nowrap">
                        {gap}
                      </span>
                    )}
                  </div>
                )}

                {/* ── Touchpoint node ── */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="flex flex-col items-center gap-1 group outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg p-1"
                    >
                      <div
                        className={cn(
                          "h-9 w-9 rounded-full flex items-center justify-center transition-all",
                          "group-hover:scale-110 group-hover:shadow-md",
                          planned
                            ? cn("border-2 border-dashed bg-white", colors.border)
                            : cn(colors.bg, "text-white shadow-sm ring-2", colors.ring)
                        )}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <span className="text-[9px] text-muted-foreground whitespace-nowrap leading-none">
                        {fmtDate(tpDate, "d MMM")}
                      </span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-3 space-y-2" align="center">
                    <TouchpointPopoverContent tp={tp} typeName={getTypeName(tp)} />
                  </PopoverContent>
                </Popover>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Detail list fallback ── */}
      <div className="border-t pt-3">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
          All Touchpoints ({sorted.length})
        </p>
        <div className="max-h-48 overflow-y-auto space-y-1.5 scrollbar-thin">
          {[...sorted].reverse().map(tp => {
            const Icon = getTypeIcon(tp);
            const planned = isPlannedFuture(tp);
            const outcome = tp.outcome || "no_response";
            const colors = OUTCOME_COLORS[outcome] || OUTCOME_COLORS.no_response;
            const tpDate = tp.logged_at || tp.follow_up_date || tp.created_date;

            return (
              <div
                key={tp.id}
                className={cn(
                  "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs",
                  "hover:bg-muted/50 transition-colors",
                  planned && "opacity-70"
                )}
              >
                <div className={cn(
                  "h-6 w-6 rounded-full flex items-center justify-center shrink-0",
                  planned
                    ? cn("border border-dashed", colors.border)
                    : cn(colors.bg, "text-white")
                )}>
                  <Icon className="h-3 w-3" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate">{getTypeName(tp)}</span>
                    {planned && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                        Planned
                      </Badge>
                    )}
                  </div>
                  {tp.notes && (
                    <p className="text-muted-foreground truncate mt-0.5">{tp.notes}</p>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                  {tpDate ? formatRelative(tpDate) : "--"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──

function StatPill({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-1.5 bg-muted/50 rounded-lg px-2.5 py-1.5">
      <Icon className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      <span className="text-[10px] text-muted-foreground">{label}:</span>
      <span className="text-xs font-semibold">{value}</span>
    </div>
  );
}

function TouchpointPopoverContent({ tp, typeName }) {
  const tpDate = tp.logged_at || tp.follow_up_date || tp.created_date;
  const outcome = tp.outcome || "no_response";
  const outcomeBadge = OUTCOME_BADGE[outcome];
  const sentimentBadge = tp.sentiment ? SENTIMENT_BADGE[tp.sentiment] : null;

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{typeName}</span>
        {tp.is_planned && !tp.completed_at && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">Planned</Badge>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        {tpDate ? fmtDate(tpDate, "d MMM yyyy") : "--"}
        {tp.duration_minutes ? ` / ${tp.duration_minutes} min` : ""}
      </p>

      {tp.notes && (
        <p className="text-xs text-foreground/80 leading-relaxed">{tp.notes}</p>
      )}

      <div className="flex flex-wrap gap-1.5 pt-1">
        {outcomeBadge && (
          <Badge
            variant={outcomeBadge.variant || "outline"}
            className={cn("text-[9px] px-1.5 py-0 h-4", outcomeBadge.className)}
          >
            {outcomeBadge.label}
          </Badge>
        )}
        {sentimentBadge && (
          <Badge
            variant="outline"
            className={cn("text-[9px] px-1.5 py-0 h-4", sentimentBadge.className)}
          >
            {sentimentBadge.label}
          </Badge>
        )}
      </div>

      {tp.logged_by && (
        <p className="text-[9px] text-muted-foreground/60 pt-1">
          Logged by {tp.logged_by}
        </p>
      )}
    </>
  );
}

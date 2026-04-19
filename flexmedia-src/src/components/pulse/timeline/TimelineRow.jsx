/**
 * TimelineRow — one timeline entry row with icon + colored left-border,
 * prominent title, truncated description, relative time (absolute ISO in
 * tooltip), clickable source chip (opens SourceDrillDrawer), and entity pill
 * (opens the matching dossier).
 *
 * Shared by:
 *   - PulseTimeline.jsx       (entity dossier timeline — full mode)
 *   - PulseTimelineTab.jsx    (full audit tab — Agent A imports this)
 *   - PulseCommandCenter.jsx  (recent-10 tile — compact mode)
 *
 * Public API (props):
 *   entry                — pulse_timeline row {id, event_type, title, description,
 *                          previous_value, new_value, source, created_at, entity_type,
 *                          pulse_entity_id, rea_id, metadata, sync_log_id}
 *   entityName           — optional resolved display name for the entity. When
 *                          provided we render a pill; when absent we fall back
 *                          to "<Type> <short-id>" so UUIDs never show in primary UI.
 *   entityHref           — optional URL used by the entity pill (clickable)
 *   onOpenEntity         — optional callback; preferred over entityHref (uses app slideouts)
 *   onOpenSourceDrill    — (source, createdAt) => void — opens SourceDrillDrawer
 *   onOpenSyncLog        — optional (syncLogId) => void — when provided, the
 *                          sync-log external-link icon invokes this instead of
 *                          <Link>-navigating to the Data Sources tab. Lets
 *                          slideout-embedded timelines open a nested drawer
 *                          without collapsing the slideout stack. Omit to keep
 *                          the legacy full-navigate behaviour (e.g. inside the
 *                          PulseTimelineTab which IS the destination).
 *   sourceStatus         — optional sync-log status for chip coloring (green/amber/red)
 *   compact              — dense, no description, smaller type (CommandCenter tile)
 *   showRelativeTime     — default true; set false to always show absolute
 *   renderDetail         — optional slot for event-specific detail panels
 */
import React from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import { configFor, CATEGORY_BORDER, sourceChipClass } from "./timelineIcons";

/* ── Date formatting (shared with PulseTimeline.jsx legacy formatter) ─────── */
function formatRelative(dateStr, compact = false) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) {
    if (compact) return `${diffHours}h ago`;
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  }
  if (!compact) {
    if (diffDays === 0) return `Today at ${d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
    if (diffDays === 1) return `Yesterday at ${d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
  } else {
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
  }
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function formatAbsolute(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toISOString();
}

/* ── Entity pill — renders a clickable chip with the entity NAME ─────────── */
function EntityPill({ entry, entityName, entityHref, onOpenEntity, compact }) {
  const type = entry.entity_type;
  const id = entry.pulse_entity_id;
  if (!type || (!entityName && !id)) return null;

  const fallback = id ? `${type} ${String(id).slice(0, 8)}` : type;
  const label = entityName || fallback;

  const chipClass = cn(
    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 font-medium",
    "bg-muted/40 border-border/60 text-foreground/80",
    "hover:bg-primary/10 hover:border-primary/40 hover:text-primary transition-colors",
    compact ? "text-[9px]" : "text-[10px]",
  );

  const content = (
    <>
      <span className="truncate max-w-[140px]" title={label}>{label}</span>
    </>
  );

  if (onOpenEntity && id) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpenEntity({ type, id }); }}
        className={chipClass}
      >
        {content}
      </button>
    );
  }
  if (entityHref) {
    return (
      <Link to={entityHref} onClick={(e) => e.stopPropagation()} className={chipClass}>
        {content}
      </Link>
    );
  }
  return (
    <span className={chipClass} title={`Entity id: ${id || "—"}`}>
      {content}
    </span>
  );
}

/* ── Source chip — clickable; opens SourceDrillDrawer ────────────────────── */
function SourceChip({ source, sourceStatus, onOpenSourceDrill, createdAt, compact }) {
  if (!source) return null;
  const cls = sourceChipClass(sourceStatus);
  const clickable = typeof onOpenSourceDrill === "function";
  const base = cn(
    "inline-flex items-center gap-1 rounded-md border px-1.5 py-0 font-mono truncate max-w-[160px]",
    cls,
    compact ? "text-[8px]" : "text-[9px]",
    clickable && "hover:underline cursor-pointer",
  );
  if (!clickable) {
    return <span className={base} title={source}>{source}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpenSourceDrill(source, createdAt); }}
      className={base}
      title={`View sync run for ${source}`}
    >
      <span className="truncate">{source}</span>
    </button>
  );
}

/* ── Main row ────────────────────────────────────────────────────────────── */
export default function TimelineRow({
  entry,
  entityName,
  entityHref,
  onOpenEntity,
  onOpenSourceDrill,
  onOpenSyncLog,
  sourceStatus,
  compact = false,
  showRelativeTime = true,
  renderDetail,
  isLast = false,
}) {
  const config = configFor(entry.event_type);
  const Icon = config.icon;
  const borderCls = CATEGORY_BORDER[config.category] || CATEGORY_BORDER.other;

  const canDrill = !!(onOpenEntity && entry.pulse_entity_id && entry.entity_type);
  const handleRowClick = canDrill
    ? () => onOpenEntity({ type: entry.entity_type, id: entry.pulse_entity_id })
    : undefined;

  const timeLabel = showRelativeTime ? formatRelative(entry.created_at, compact) : formatAbsolute(entry.created_at);
  const timeTooltip = entry.created_at ? new Date(entry.created_at).toLocaleString("en-AU") + ` (${formatAbsolute(entry.created_at)})` : "";

  return (
    <div className={cn("flex group relative", compact ? "gap-2" : "gap-3")}>
      {/* Timeline dot + connector line */}
      <div className="flex flex-col items-center shrink-0 pt-0.5">
        <div className={cn(
          "rounded-full flex items-center justify-center shrink-0",
          config.color,
          compact ? "w-4 h-4" : "w-6 h-6",
        )}>
          <Icon className={cn("text-white", compact ? "h-2 w-2" : "h-3 w-3")} />
        </div>
        {!isLast && (
          <div className={cn("w-px flex-1 bg-border", compact ? "mt-0.5" : "mt-1")} />
        )}
      </div>

      {/* Body */}
      <div
        className={cn(
          "flex-1 min-w-0 border-l-2 pl-2 -ml-[1px]",
          borderCls,
          compact ? "pb-2" : "pb-4",
          canDrill && "cursor-pointer rounded-md hover:bg-muted/40 transition-colors -mx-1 px-2",
        )}
        onClick={handleRowClick}
        role={canDrill ? "button" : undefined}
        tabIndex={canDrill ? 0 : undefined}
        onKeyDown={canDrill ? (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleRowClick();
          }
        } : undefined}
      >
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className={cn(
              "font-semibold leading-tight",
              compact ? "text-[11px]" : "text-sm",
            )}>
              {entry.title}
            </p>
            {!compact && entry.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {entry.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span
              className={cn(
                "text-muted-foreground/70 tabular-nums",
                compact ? "text-[8px]" : "text-[10px]",
              )}
              title={timeTooltip}
            >
              {timeLabel}
            </span>
            {entry.sync_log_id && (
              typeof onOpenSyncLog === "function" ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenSyncLog(entry.sync_log_id); }}
                  className="text-muted-foreground/40 hover:text-primary transition-colors"
                  title="Open source run details"
                >
                  <ExternalLink className={cn(compact ? "h-2.5 w-2.5" : "h-3 w-3")} />
                </button>
              ) : (
                <Link
                  to={`/IndustryPulse?tab=sources&sync_log_id=${entry.sync_log_id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground/40 hover:text-primary transition-colors"
                  title="Open source run details (Data Sources tab)"
                >
                  <ExternalLink className={cn(compact ? "h-2.5 w-2.5" : "h-3 w-3")} />
                </Link>
              )
            )}
          </div>
        </div>

        {/* Event-specific detail panel (delegated to parent via renderDetail) */}
        {!compact && typeof renderDetail === "function" && renderDetail(entry)}

        {/* Meta row: category label + source chip + entity pill */}
        <div className={cn(
          "flex items-center gap-1.5 flex-wrap",
          compact ? "mt-0.5" : "mt-1.5",
        )}>
          <Badge
            variant="outline"
            className={cn(
              "px-1 py-0 font-medium",
              compact ? "text-[7px]" : "text-[9px]",
              config.category_color,
            )}
          >
            {config.label}
          </Badge>
          {entry.source && (
            <SourceChip
              source={entry.source}
              sourceStatus={sourceStatus}
              onOpenSourceDrill={onOpenSourceDrill}
              createdAt={entry.created_at}
              compact={compact}
            />
          )}
          <EntityPill
            entry={entry}
            entityName={entityName}
            entityHref={entityHref}
            onOpenEntity={onOpenEntity}
            compact={compact}
          />
        </div>
      </div>
    </div>
  );
}

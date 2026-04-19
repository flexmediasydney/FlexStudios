/**
 * EnrichmentBadge — universal "is this listing's data complete?" indicator.
 *
 * Drops into every listing surface in the app so users can tell at a glance
 * whether what they're seeing is a scrape-only snapshot (hero + bare image
 * URLs + no typed media) or a fully-enriched detail pull (typed media_items
 * with floorplans, videos, drone counts, accurate classification).
 *
 * 3 states:
 *   • fresh    — detail_enriched_at set + within freshness window
 *   • pending  — never enriched yet; still waiting for pulseDetailEnrich
 *   • stale    — enriched >14 days ago (media may have changed since)
 *
 * Throughput context in tooltip:
 *   pulseDetailEnrich runs every 5 min at BATCH_SIZE=12 (~144/hr, ~3,500/day)
 *   At ~4 days to clear the current backlog
 *
 * Usage:
 *   <EnrichmentBadge listing={l} />            // inline icon + tooltip
 *   <EnrichmentBadge listing={l} compact />    // dot only, 10px, for dense tables
 *   <EnrichmentBadge listing={l} size="lg" />  // card header (icon + text)
 */
import React from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const FRESHNESS_STALE_DAYS = 14;

function deriveState(listing) {
  if (!listing) return { key: "unknown", label: "Unknown", color: "slate", Icon: Clock };
  const enrichedAt = listing.detail_enriched_at;
  if (!enrichedAt) {
    return {
      key: "pending",
      label: "Pending enrichment",
      color: "amber",
      Icon: Clock,
      reason: "Never enriched — scrape-only snapshot. Media types, floorplan detection, and classification not yet determined.",
    };
  }
  const enrichedDate = new Date(enrichedAt);
  const ageDays = (Date.now() - enrichedDate.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > FRESHNESS_STALE_DAYS) {
    return {
      key: "stale",
      label: "Stale enrichment",
      color: "amber",
      Icon: AlertTriangle,
      reason: `Enriched ${Math.round(ageDays)}d ago. Media may have changed since (new campaign, different package).`,
      enrichedDate,
      ageDays,
    };
  }
  return {
    key: "fresh",
    label: "Enriched",
    color: "emerald",
    Icon: CheckCircle2,
    reason: `Enriched ${Math.round(ageDays * 24)}h ago (${enrichedDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}).`,
    enrichedDate,
    ageDays,
  };
}

const COLOR_CLASSES = {
  emerald: { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", dot: "bg-emerald-500" },
  amber:   { text: "text-amber-700",   bg: "bg-amber-50",   border: "border-amber-200",   dot: "bg-amber-500" },
  slate:   { text: "text-slate-700",   bg: "bg-slate-50",   border: "border-slate-200",   dot: "bg-slate-400" },
};

/**
 * Universal enrichment state indicator.
 *
 * @param {object}   props.listing   Must have at least `detail_enriched_at`.
 * @param {"sm"|"md"|"lg"} [props.size="sm"]
 * @param {boolean}  [props.compact]    Dot-only. Best for dense tables.
 * @param {boolean}  [props.hideLabel]  Icon only, no text.
 * @param {boolean}  [props.disableTooltip]
 */
export default function EnrichmentBadge({
  listing,
  size = "sm",
  compact = false,
  hideLabel = false,
  disableTooltip = false,
  className,
}) {
  const state = deriveState(listing);
  const colors = COLOR_CLASSES[state.color] || COLOR_CLASSES.slate;
  const Icon = state.Icon;

  const tooltipContent = (
    <div className="text-[11px] max-w-xs space-y-1">
      <div className="font-medium">{state.label}</div>
      {state.reason && <div className="text-muted-foreground">{state.reason}</div>}
      {state.key === "pending" && (
        <div className="text-muted-foreground pt-1 border-t">
          Enricher runs every 5 min, ~12 listings per batch (~3,500/day). Current backlog is ~4 days at steady state. Staff can force-prioritise a specific listing from the slideout.
        </div>
      )}
    </div>
  );

  // Dot-only
  if (compact) {
    const node = (
      <span
        className={cn("inline-block w-2 h-2 rounded-full", colors.dot, className)}
        aria-label={state.label}
      />
    );
    if (disableTooltip) return node;
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>{node}</TooltipTrigger>
          <TooltipContent side="top">{tooltipContent}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Icon + label
  const sizeClasses = {
    sm: "text-[10px] h-4 px-1 gap-0.5",
    md: "text-xs h-5 px-1.5 gap-1",
    lg: "text-sm h-6 px-2 gap-1.5",
  };
  const iconSize = { sm: "h-2.5 w-2.5", md: "h-3 w-3", lg: "h-3.5 w-3.5" };

  const badge = (
    <Badge
      className={cn(
        "inline-flex items-center font-medium",
        colors.bg,
        colors.text,
        colors.border,
        sizeClasses[size] || sizeClasses.sm,
        className,
      )}
      variant="outline"
    >
      <Icon className={iconSize[size] || iconSize.sm} />
      {!hideLabel && <span>{size === "sm" ? state.label.split(" ")[0] : state.label}</span>}
    </Badge>
  );

  if (disableTooltip) return badge;
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top">{tooltipContent}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Also export the deriver so callers can take conditional actions based on state
export { deriveState as deriveEnrichmentState };

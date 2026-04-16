/**
 * PulseTimeline — Reusable timeline component for Industry Pulse events.
 * Shows agent movements, listing activity, mapping events, and system syncs.
 * Used in: Industry Pulse (Mappings tab), PersonDetails (Intelligence tab), OrgDetails (Intelligence tab),
 *          PulseAgentIntel (slideout), PulseAgencyIntel (slideout)
 *
 * Props:
 *   entries        — array of timeline event objects
 *   showEntityName — show entity name on each entry
 *   maxHeight      — Tailwind max-height class
 *   emptyMessage   — message when no entries
 *   compact        — reduced padding, hides descriptions, filters system events
 */
import React, { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ArrowRight, Star, Home, User, Building2, Zap, RefreshCw, Link2, UserPlus,
  TrendingUp, Clock, Calendar, ChevronDown, ExternalLink, AlertTriangle,
  DollarSign, Play, CheckCircle2, Timer, ListPlus
} from "lucide-react";

/* ── System event types that get filtered out in compact mode ────────────── */
const SYSTEM_EVENT_TYPES = new Set([
  "cron_dispatched",
  "scheduled_scrape_started",
  "scheduled_scrape_completed",
  "data_sync",
]);

/* ── Event type configuration ────────────────────────────────────────────── */
const EVENT_CONFIG = {
  // Agent / entity events
  first_seen:               { icon: Zap,          color: "bg-cyan-500",    label: "First Detected",     category_color: "text-cyan-600 dark:text-cyan-400" },
  agency_change:            { icon: ArrowRight,    color: "bg-blue-500",    label: "Agency Change",      category_color: "text-blue-600 dark:text-blue-400" },
  new_listings_detected:    { icon: ListPlus,      color: "bg-green-500",   label: "New Listings",       category_color: "text-green-600 dark:text-green-400" },
  client_new_listing:       { icon: Home,          color: "bg-emerald-500", label: "Client Listing",     category_color: "text-emerald-600 dark:text-emerald-400" },
  price_change:             { icon: DollarSign,    color: "bg-amber-500",   label: "Price Change",       category_color: "text-amber-600 dark:text-amber-400" },
  status_change:            { icon: ArrowRight,    color: "bg-blue-500",    label: "Status Change",      category_color: "text-blue-600 dark:text-blue-400" },

  // Legacy / other entity events
  listing_new:              { icon: Home,          color: "bg-green-500",   label: "New Listing",        category_color: "text-green-600 dark:text-green-400" },
  listing_sold:             { icon: TrendingUp,    color: "bg-emerald-500", label: "Listing Sold",       category_color: "text-emerald-600 dark:text-emerald-400" },
  rating_change:            { icon: Star,          color: "bg-amber-500",   label: "Rating Changed",     category_color: "text-amber-600 dark:text-amber-400" },
  title_change:             { icon: User,          color: "bg-purple-500",  label: "Title Changed",      category_color: "text-purple-600 dark:text-purple-400" },
  crm_mapped:               { icon: Link2,         color: "bg-indigo-500",  label: "CRM Mapped",         category_color: "text-indigo-600 dark:text-indigo-400" },
  crm_added:                { icon: UserPlus,      color: "bg-green-600",   label: "Added to CRM",       category_color: "text-green-600 dark:text-green-400" },

  // System events
  cron_dispatched:          { icon: Timer,         color: "bg-gray-400",    label: "Cron Dispatched",    category_color: "text-gray-500" },
  scheduled_scrape_started: { icon: Play,          color: "bg-gray-400",    label: "Scrape Started",     category_color: "text-gray-500" },
  scheduled_scrape_completed: { icon: CheckCircle2, color: "bg-gray-400",   label: "Scrape Completed",   category_color: "text-gray-500" },
  data_sync:                { icon: RefreshCw,     color: "bg-gray-400",    label: "Data Sync",          category_color: "text-gray-500" },
};

/* ── Fallback config for unknown event types ─────────────────────────────── */
const FALLBACK_CONFIG = { icon: RefreshCw, color: "bg-gray-400", label: "Event", category_color: "text-gray-500" };

/* ── Date formatting ─────────────────────────────────────────────────────── */
function formatDate(dateStr, compact = false) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // Very recent — show relative
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) {
    if (compact) return `${diffHours}h ago`;
    return diffHours === 1
      ? `1 hour ago`
      : `${diffHours} hours ago`;
  }

  // Today / Yesterday with time (full mode)
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

/* ── Price formatting ────────────────────────────────────────────────────── */
function formatPrice(val) {
  if (!val && val !== 0) return "N/A";
  const num = typeof val === "string" ? parseFloat(val.replace(/[^0-9.]/g, "")) : val;
  if (isNaN(num)) return val;
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(num);
}

/* ── Status badge color mapping ──────────────────────────────────────────── */
function statusBadgeClass(status) {
  if (!status) return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  const s = String(status).toLowerCase().replace(/[_\s]/g, "");
  if (s.includes("sold"))    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (s.includes("sale") || s.includes("buy")) return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
  if (s.includes("rent") || s.includes("lease")) return "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300";
  if (s.includes("withdrawn") || s.includes("removed")) return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  if (s.includes("auction")) return "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300";
  return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
}

function humanizeStatus(status) {
  if (!status) return "Unknown";
  return String(status)
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

/* ── Grouping ────────────────────────────────────────────────────────────── */
function groupByMonth(entries) {
  const groups = {};
  for (const entry of entries) {
    const d = new Date(entry.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
    if (!groups[key]) groups[key] = { label, entries: [] };
    groups[key].entries.push(entry);
  }
  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
}

/* ── Detail renderers ────────────────────────────────────────────────────── */

function AgencyChangeDetail({ prevVal, newVal }) {
  if (!prevVal && !newVal) return null;
  const prevName = typeof prevVal === "string" ? prevVal : prevVal?.agency_name;
  const newName  = typeof newVal === "string"  ? newVal  : newVal?.agency_name;
  const prevReaId = typeof prevVal === "object" ? prevVal?.agency_rea_id : null;
  const newReaId  = typeof newVal === "object"  ? newVal?.agency_rea_id  : null;

  return (
    <div className="mt-2 text-xs bg-muted/30 rounded-lg p-2.5 space-y-1">
      {prevName && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">From:</span>
          <span className="font-medium line-through text-muted-foreground">{prevName}</span>
          {prevReaId && <span className="text-[9px] text-muted-foreground/50">REA: {prevReaId}</span>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">To:</span>
        <span className="font-medium text-foreground">{newName || "Unknown"}</span>
        {newReaId && <span className="text-[9px] text-muted-foreground/50">REA: {newReaId}</span>}
      </div>
    </div>
  );
}

function PriceChangeDetail({ prevVal, newVal }) {
  const oldPrice = typeof prevVal === "object" ? prevVal?.price : prevVal;
  const newPrice = typeof newVal === "object"  ? newVal?.price  : newVal;
  if (!oldPrice && !newPrice) return null;

  const oldNum = parseFloat(String(oldPrice).replace(/[^0-9.]/g, "")) || 0;
  const newNum = parseFloat(String(newPrice).replace(/[^0-9.]/g, "")) || 0;
  const diff = newNum - oldNum;
  const pctChange = oldNum > 0 ? ((diff / oldNum) * 100).toFixed(1) : null;

  return (
    <div className="mt-2 text-xs bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-2.5 space-y-1">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground line-through">{formatPrice(oldPrice)}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="font-semibold text-foreground">{formatPrice(newPrice)}</span>
        {pctChange && (
          <Badge variant="outline" className={cn(
            "text-[9px] px-1.5 py-0",
            diff > 0 ? "text-green-600 border-green-300" : "text-red-600 border-red-300"
          )}>
            {diff > 0 ? "+" : ""}{pctChange}%
          </Badge>
        )}
      </div>
    </div>
  );
}

function StatusChangeDetail({ prevVal, newVal }) {
  const oldStatus = typeof prevVal === "object" ? prevVal?.status : prevVal;
  const newStatus = typeof newVal === "object"  ? newVal?.status  : newVal;
  if (!oldStatus && !newStatus) return null;

  return (
    <div className="mt-2 text-xs bg-blue-50/50 dark:bg-blue-900/10 rounded-lg p-2.5">
      <div className="flex items-center gap-2">
        {oldStatus && (
          <Badge className={cn("text-[9px] px-1.5 py-0 font-medium", statusBadgeClass(oldStatus))}>
            {humanizeStatus(oldStatus)}
          </Badge>
        )}
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <Badge className={cn("text-[9px] px-1.5 py-0 font-semibold", statusBadgeClass(newStatus))}>
          {humanizeStatus(newStatus)}
        </Badge>
      </div>
    </div>
  );
}

function FirstSeenDetail({ newVal }) {
  if (!newVal) return null;
  const agencyName = typeof newVal === "object" ? newVal?.agency_name : null;
  const suburb     = typeof newVal === "object" ? newVal?.suburb : null;
  if (!agencyName && !suburb) return null;

  return (
    <div className="mt-1.5 flex gap-1.5 flex-wrap">
      {agencyName && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{agencyName}</Badge>}
      {suburb && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{suburb}</Badge>}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

export default function PulseTimeline({
  entries = [],
  showEntityName = false,
  maxHeight = "max-h-[600px]",
  emptyMessage = "No timeline events yet",
  compact = false,
}) {
  // In compact mode, filter out system events
  const filteredEntries = useMemo(() => {
    if (!compact) return entries;
    return entries.filter(e => !SYSTEM_EVENT_TYPES.has(e.event_type));
  }, [entries, compact]);

  const grouped = useMemo(() => groupByMonth(filteredEntries), [filteredEntries]);

  if (filteredEntries.length === 0) {
    return (
      <div className={cn("text-center", compact ? "py-4" : "py-8")}>
        <Clock className={cn("text-muted-foreground/30 mx-auto mb-2", compact ? "h-5 w-5" : "h-8 w-8")} />
        <p className={cn("text-muted-foreground/50", compact ? "text-[10px]" : "text-sm")}>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={cn("overflow-y-auto", maxHeight)}>
      {grouped.map(([key, group]) => (
        <div key={key} className={compact ? "mb-2" : "mb-4"}>
          {/* Month header */}
          <div className={cn(
            "sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-1 mb-1",
            compact ? "py-0.5" : "py-1.5 mb-2"
          )}>
            <p className={cn(
              "font-semibold text-muted-foreground uppercase tracking-wider",
              compact ? "text-[8px]" : "text-[10px]"
            )}>{group.label}</p>
          </div>

          {/* Entries */}
          <div className="space-y-0">
            {group.entries.map((entry, i) => {
              const config = EVENT_CONFIG[entry.event_type] || FALLBACK_CONFIG;
              const Icon = config.icon;
              const prevVal = entry.previous_value;
              const newVal = entry.new_value;

              return (
                <div key={entry.id || i} className={cn("flex group relative", compact ? "gap-2" : "gap-3")}>
                  {/* Timeline line + dot */}
                  <div className="flex flex-col items-center shrink-0 pt-0.5">
                    <div className={cn(
                      "rounded-full flex items-center justify-center shrink-0",
                      config.color,
                      compact ? "w-4 h-4" : "w-6 h-6"
                    )}>
                      <Icon className={cn("text-white", compact ? "h-2 w-2" : "h-3 w-3")} />
                    </div>
                    {i < group.entries.length - 1 && (
                      <div className={cn("w-px flex-1 bg-border", compact ? "mt-0.5" : "mt-1")} />
                    )}
                  </div>

                  {/* Content */}
                  <div className={cn("flex-1 min-w-0", compact ? "pb-2" : "pb-4")}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={cn(
                          "font-medium leading-tight",
                          compact ? "text-[11px]" : "text-sm"
                        )}>{entry.title}</p>

                        {/* Description — hidden in compact mode */}
                        {!compact && entry.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{entry.description}</p>
                        )}
                      </div>
                      <span className={cn(
                        "text-muted-foreground/60 shrink-0 tabular-nums",
                        compact ? "text-[8px]" : "text-[10px]"
                      )}>{formatDate(entry.created_at, compact)}</span>
                    </div>

                    {/* Event-specific detail panels — hidden in compact mode */}
                    {!compact && (
                      <>
                        {entry.event_type === "agency_change" && (
                          <AgencyChangeDetail prevVal={prevVal} newVal={newVal} />
                        )}
                        {entry.event_type === "price_change" && (
                          <PriceChangeDetail prevVal={prevVal} newVal={newVal} />
                        )}
                        {entry.event_type === "status_change" && (
                          <StatusChangeDetail prevVal={prevVal} newVal={newVal} />
                        )}
                        {entry.event_type === "first_seen" && (
                          <FirstSeenDetail newVal={newVal} />
                        )}
                      </>
                    )}

                    {/* Metadata badges */}
                    {!compact && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <Badge variant="outline" className={cn("text-[8px] px-1 py-0", config.category_color)}>{config.label}</Badge>
                        {entry.source && <Badge variant="outline" className="text-[8px] px-1 py-0 text-muted-foreground">{entry.source}</Badge>}
                        {entry.rea_id && <span className="text-[9px] text-muted-foreground/40">REA: {entry.rea_id}</span>}
                      </div>
                    )}

                    {/* Compact mode: inline category badge only */}
                    {compact && (
                      <Badge variant="outline" className={cn("text-[7px] px-1 py-0 mt-0.5", config.category_color)}>{config.label}</Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export { EVENT_CONFIG };

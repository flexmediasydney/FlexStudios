/**
 * PulseTimeline — Reusable timeline component for Industry Pulse events.
 * Shows agent movements, listing activity, mapping events, and system syncs.
 * Used in: Industry Pulse (Mappings tab), PersonDetails (Intelligence tab), OrgDetails (Intelligence tab)
 */
import React, { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ArrowRight, Star, Home, User, Building2, Zap, RefreshCw, Link2, UserPlus,
  TrendingUp, Clock, Calendar, ChevronDown, ExternalLink, AlertTriangle
} from "lucide-react";

const EVENT_CONFIG = {
  agency_change: { icon: ArrowRight, color: "bg-blue-500", label: "Agency Change", category_color: "text-blue-600 dark:text-blue-400" },
  listing_new: { icon: Home, color: "bg-green-500", label: "New Listing", category_color: "text-green-600 dark:text-green-400" },
  listing_sold: { icon: TrendingUp, color: "bg-emerald-500", label: "Listing Sold", category_color: "text-emerald-600 dark:text-emerald-400" },
  rating_change: { icon: Star, color: "bg-amber-500", label: "Rating Changed", category_color: "text-amber-600 dark:text-amber-400" },
  title_change: { icon: User, color: "bg-purple-500", label: "Title Changed", category_color: "text-purple-600 dark:text-purple-400" },
  first_seen: { icon: Zap, color: "bg-cyan-500", label: "First Detected", category_color: "text-cyan-600 dark:text-cyan-400" },
  data_sync: { icon: RefreshCw, color: "bg-gray-400", label: "Data Sync", category_color: "text-gray-500" },
  crm_mapped: { icon: Link2, color: "bg-indigo-500", label: "CRM Mapped", category_color: "text-indigo-600 dark:text-indigo-400" },
  crm_added: { icon: UserPlus, color: "bg-green-600", label: "Added to CRM", category_color: "text-green-600 dark:text-green-400" },
};

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return `Today at ${d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
  if (diffDays === 1) return `Yesterday at ${d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

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

export default function PulseTimeline({ entries = [], showEntityName = false, maxHeight = "max-h-[600px]", emptyMessage = "No timeline events yet" }) {
  const grouped = useMemo(() => groupByMonth(entries), [entries]);

  if (entries.length === 0) {
    return (
      <div className="text-center py-8">
        <Clock className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground/50">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={cn("overflow-y-auto", maxHeight)}>
      {grouped.map(([key, group]) => (
        <div key={key} className="mb-4">
          {/* Month header */}
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-1 py-1.5 mb-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{group.label}</p>
          </div>

          {/* Entries */}
          <div className="space-y-0">
            {group.entries.map((entry, i) => {
              const config = EVENT_CONFIG[entry.event_type] || EVENT_CONFIG.data_sync;
              const Icon = config.icon;
              const prevVal = entry.previous_value;
              const newVal = entry.new_value;

              return (
                <div key={entry.id} className="flex gap-3 group relative">
                  {/* Timeline line + dot */}
                  <div className="flex flex-col items-center shrink-0 pt-1">
                    <div className={cn("w-6 h-6 rounded-full flex items-center justify-center shrink-0", config.color)}>
                      <Icon className="h-3 w-3 text-white" />
                    </div>
                    {i < group.entries.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                  </div>

                  {/* Content */}
                  <div className="flex-1 pb-4 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-tight">{entry.title}</p>
                        {entry.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{entry.description}</p>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">{formatDate(entry.created_at)}</span>
                    </div>

                    {/* Before → After snapshot for movements */}
                    {entry.event_type === "agency_change" && prevVal && newVal && (
                      <div className="mt-2 text-xs bg-muted/30 rounded-lg p-2.5 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">From:</span>
                          <span className="font-medium line-through text-muted-foreground">{prevVal.agency_name}</span>
                          {prevVal.agency_rea_id && <span className="text-[9px] text-muted-foreground/50">REA: {prevVal.agency_rea_id}</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">To:</span>
                          <span className="font-medium text-foreground">{newVal.agency_name}</span>
                          {newVal.agency_rea_id && <span className="text-[9px] text-muted-foreground/50">REA: {newVal.agency_rea_id}</span>}
                        </div>
                      </div>
                    )}

                    {/* First seen details */}
                    {entry.event_type === "first_seen" && newVal && (
                      <div className="mt-1.5 flex gap-1.5 flex-wrap">
                        {newVal.agency_name && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{newVal.agency_name}</Badge>}
                        {newVal.suburb && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{newVal.suburb}</Badge>}
                      </div>
                    )}

                    {/* Metadata badges */}
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <Badge variant="outline" className={cn("text-[8px] px-1 py-0", config.category_color)}>{config.label}</Badge>
                      {entry.source && <Badge variant="outline" className="text-[8px] px-1 py-0 text-muted-foreground">{entry.source}</Badge>}
                      {entry.rea_id && <span className="text-[9px] text-muted-foreground/40">REA: {entry.rea_id}</span>}
                    </div>
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

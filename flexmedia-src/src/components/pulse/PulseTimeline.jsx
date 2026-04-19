/**
 * PulseTimeline — Reusable timeline component for Industry Pulse events.
 * Shows agent movements, listing activity, mapping events, and system syncs.
 *
 * Used in: Industry Pulse (Mappings tab), PersonDetails (Intelligence tab),
 *          OrgDetails (Intelligence tab), PulseAgentIntel (slideout),
 *          PulseAgencyIntel (slideout), PulseCommandCenter (preview tile),
 *          PulseIntelligencePanel (dossier Section 12).
 *
 * Public API (all optional — backward compatible):
 *   entries           — array of pulse_timeline rows
 *   showEntityName    — legacy — now auto-resolves via entityNameMap when absent
 *   maxHeight         — Tailwind max-h class (default "max-h-[600px]")
 *   emptyMessage      — placeholder when no rows
 *   compact           — dense mode, hides descriptions + system events
 *   onOpenEntity      — ({type, id}) => void — preferred click handler
 *
 * Added in the big redesign (all optional, all nullable):
 *   showFilters       — render filter + search toolbar (default: !compact)
 *   showSourceDrill   — enable source chip drill-through (default: true)
 *   virtualize        — force virtualization on/off; auto-enables >100 rows
 *   entityNameMap     — {[`${type}:${id}`]: displayName} for pill labels (avoids UUIDs)
 *   defaultCategory   — initial category filter value
 *   onOpenSyncLog     — optional (syncLogId) => void — threaded to TimelineRow
 *                       so slideout-embedded timelines (dossier) open a nested
 *                       drawer instead of full-navigating. Omit to keep the
 *                       legacy <Link> behaviour on tab surfaces.
 *
 * Data shape expected per entry:
 *   { id, entity_type, pulse_entity_id, crm_entity_id, rea_id, event_type,
 *     event_category, title, description, previous_value, new_value, source,
 *     metadata, created_at, idempotency_key, sync_log_id? }
 */
import React, { useMemo, useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRight, Clock, AtSign, Phone, Gavel, FileImage, Video, XCircle,
  CheckCircle2, RefreshCw, Search, X,
} from "lucide-react";
import TimelineRow from "./timeline/TimelineRow";
import SourceDrillDrawer from "./timeline/SourceDrillDrawer";
import useEntityNameMap from "./timeline/useEntityNameMap";
import {
  EVENT_CONFIG, SYSTEM_EVENT_TYPES, configFor,
} from "./timeline/timelineIcons";

/* ── Re-export EVENT_CONFIG so existing callers keep working ─────────────── */
export { EVENT_CONFIG };

/* ── Category registry for the filter dropdown ───────────────────────────── */
const CATEGORY_FILTER_OPTIONS = [
  { value: "all",      label: "All categories" },
  { value: "movement", label: "Movement" },
  { value: "market",   label: "Market" },
  { value: "contact",  label: "Contact" },
  { value: "media",    label: "Media" },
  { value: "mapping",  label: "Mapping" },
  { value: "signal",   label: "Signal" },
  { value: "agent",    label: "Agent" },
  { value: "system",   label: "System" },
];

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
  return String(status).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/* ── Month grouping (only used for small lists; virtualized path skips) ──── */
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

/* ── Detail renderers (same as legacy — wired through renderDetail slot) ─── */

function pickField(val, ...fields) {
  if (val == null) return null;
  if (typeof val !== "object") return val;
  for (const f of fields) {
    if (val[f] != null && val[f] !== "") return val[f];
  }
  return null;
}

function AgencyChangeDetail({ prevVal, newVal }) {
  if (!prevVal && !newVal) return null;
  const prevName = typeof prevVal === "string" ? prevVal : prevVal?.agency_name;
  const newName  = typeof newVal === "string"  ? newVal  : newVal?.agency_name;
  return (
    <div className="mt-2 text-xs bg-muted/30 rounded-lg p-2.5 space-y-1">
      {prevName && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">From:</span>
          <span className="font-medium line-through text-muted-foreground">{prevName}</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">To:</span>
        <span className="font-medium text-foreground">{newName || "Unknown"}</span>
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
    <div className="mt-2 text-xs bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-2.5">
      <div className="flex items-center gap-3 flex-wrap">
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
      <div className="flex items-center gap-2 flex-wrap">
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

function ContactDiscoveredDetail({ newVal, kind, source }) {
  const value = pickField(newVal, kind === "email" ? "email" : "mobile", "value");
  if (!value) return null;
  const srcChip = source || pickField(newVal, "source", "origin");
  const Icon = kind === "email" ? AtSign : Phone;
  return (
    <div className="mt-2 text-xs bg-emerald-50/50 dark:bg-emerald-900/10 rounded-lg p-2.5 flex items-center gap-2 flex-wrap">
      <Icon className="h-3 w-3 text-emerald-600" />
      <span className="font-mono text-[11px] font-medium text-foreground break-all">{value}</span>
      {srcChip && <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">via {srcChip}</Badge>}
    </div>
  );
}

function ContactChangedDetail({ prevVal, newVal, kind }) {
  const prev = pickField(prevVal, kind === "email" ? "email" : "mobile", "value");
  const next = pickField(newVal,  kind === "email" ? "email" : "mobile", "value");
  if (!prev && !next) return null;
  const Icon = kind === "email" ? AtSign : Phone;
  return (
    <div className="mt-2 text-xs bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Icon className="h-3 w-3 text-amber-600" />
        {prev && <span className="font-mono text-[11px] line-through text-muted-foreground break-all">{prev}</span>}
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono text-[11px] font-semibold text-foreground break-all">{next || "—"}</span>
      </div>
    </div>
  );
}

function AuctionScheduledDetail({ newVal }) {
  const dt = pickField(newVal, "auction_date", "auction_at", "scheduled_at", "date");
  const venue = pickField(newVal, "venue", "location");
  if (!dt && !venue) return null;
  let when = dt;
  if (dt) {
    const d = new Date(dt);
    if (!isNaN(d.getTime())) when = d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return (
    <div className="mt-2 text-xs bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-2.5 flex items-center gap-2 flex-wrap">
      <Gavel className="h-3 w-3 text-amber-600" />
      {when && <span className="font-medium text-foreground">{when}</span>}
      {venue && <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">{venue}</Badge>}
    </div>
  );
}

function SoldDateCapturedDetail({ newVal }) {
  const dt = pickField(newVal, "sold_date", "sold_at", "date");
  const price = pickField(newVal, "sold_price", "price");
  if (!dt && !price) return null;
  let when = dt;
  if (dt) {
    const d = new Date(dt);
    if (!isNaN(d.getTime())) when = d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }
  return (
    <div className="mt-2 text-xs bg-emerald-50/50 dark:bg-emerald-900/10 rounded-lg p-2.5 flex items-center gap-2 flex-wrap">
      <CheckCircle2 className="h-3 w-3 text-emerald-600" />
      {when && <span className="font-medium text-foreground">Sold {when}</span>}
      {price && <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-300 text-emerald-700">{formatPrice(price)}</Badge>}
    </div>
  );
}

function MediaAddedDetail({ newVal, kind }) {
  const url = typeof newVal === "string" ? newVal : pickField(newVal, "url", "thumbnail_url", "floorplan_url", "video_url");
  const thumb = typeof newVal === "object" ? pickField(newVal, "thumbnail_url", "poster_url", "preview_url") || url : url;
  if (!url && !thumb) return null;
  const Icon = kind === "video" ? Video : FileImage;
  const isImage = thumb && !/\.(mp4|webm|mov)(\?|$)/i.test(thumb);
  return (
    <div className="mt-2 text-xs bg-blue-50/50 dark:bg-blue-900/10 rounded-lg p-2.5 flex items-center gap-2 flex-wrap">
      {isImage && thumb ? (
        <img src={thumb} alt={kind === "video" ? "Video thumbnail" : "Floorplan"} className="h-12 w-16 object-cover rounded border border-border/40" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      ) : (
        <Icon className="h-3 w-3 text-blue-600" />
      )}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-[11px] text-blue-600 hover:underline truncate max-w-[220px]" title={url}>
          {kind === "video" ? "Open video" : "Open floorplan"}
        </a>
      )}
    </div>
  );
}

function WithdrawnDetail({ newVal }) {
  const reason = pickField(newVal, "reason", "withdrawal_reason", "status_reason");
  const withdrawnAt = pickField(newVal, "withdrawn_at", "withdrawn_date", "date");
  if (!reason && !withdrawnAt) return null;
  let when = withdrawnAt;
  if (withdrawnAt) {
    const d = new Date(withdrawnAt);
    if (!isNaN(d.getTime())) when = d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }
  return (
    <div className="mt-2 text-xs bg-red-50/50 dark:bg-red-900/10 rounded-lg p-2.5 flex items-center gap-2 flex-wrap">
      <XCircle className="h-3 w-3 text-red-600" />
      {when && <span className="text-muted-foreground">Withdrawn {when}</span>}
      {reason && <span className="font-medium text-foreground">{reason}</span>}
    </div>
  );
}

function RelistedDetail({ prevVal, newVal }) {
  const withdrawn = pickField(prevVal, "last_withdrawn", "withdrawn_at", "withdrawn_date");
  const relisted  = pickField(newVal,  "latest_active_at", "relisted_at", "date");
  if (!withdrawn && !relisted) return null;
  const fmt = (v) => {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  };
  return (
    <div className="mt-2 text-xs bg-muted/30 rounded-lg p-2.5 flex items-center gap-2 flex-wrap">
      <RefreshCw className="h-3 w-3 text-muted-foreground" />
      <span className="text-muted-foreground">
        Withdrawn <span className="font-medium text-foreground">{fmt(withdrawn) || "—"}</span>, relisted{" "}
        <span className="font-medium text-foreground">{fmt(relisted) || "—"}</span>
      </span>
    </div>
  );
}

function AgencyContactDiscoveredDetail({ newVal }) {
  let field = pickField(newVal, "field", "type");
  let value = pickField(newVal, "value");
  if (!value) {
    if (newVal && typeof newVal === "object") {
      if (newVal.email) { field = field || "email"; value = newVal.email; }
      else if (newVal.phone) { field = field || "phone"; value = newVal.phone; }
      else if (newVal.mobile) { field = field || "mobile"; value = newVal.mobile; }
    }
  }
  if (!value) return null;
  const Icon = /phone|mobile/i.test(field || "") ? Phone : AtSign;
  return (
    <div className="mt-2 text-xs bg-emerald-50/50 dark:bg-emerald-900/10 rounded-lg p-2.5 flex items-center gap-2 flex-wrap">
      <Icon className="h-3 w-3 text-emerald-600" />
      {field && <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">{field}</Badge>}
      <span className="font-mono text-[11px] font-medium text-foreground break-all">{value}</span>
    </div>
  );
}

function GenericPrevNewDetail({ prevVal, newVal }) {
  const hasPrev = prevVal != null && !(typeof prevVal === "object" && Object.keys(prevVal || {}).length === 0);
  const hasNew  = newVal  != null && !(typeof newVal  === "object" && Object.keys(newVal  || {}).length === 0);
  if (!hasPrev && !hasNew) return null;
  const rowsForSide = (v) => {
    if (v == null) return [];
    if (typeof v !== "object") return [{ k: "value", v: String(v) }];
    const out = [];
    for (const [k, val] of Object.entries(v)) {
      if (val == null) continue;
      if (typeof val === "object") continue;
      const s = String(val);
      if (s === "") continue;
      out.push({ k, v: s });
    }
    return out.slice(0, 6);
  };
  const prevRows = rowsForSide(prevVal);
  const newRows  = rowsForSide(newVal);
  if (prevRows.length === 0 && newRows.length === 0) return null;
  return (
    <div className="mt-2 text-xs bg-muted/30 rounded-lg p-2.5">
      <div className="grid grid-cols-2 gap-3">
        {[{ label: "Previous", rows: prevRows }, { label: "New", rows: newRows }].map(({ label, rows }) => (
          <div key={label} className="min-w-0">
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">{label}</p>
            {rows.length === 0 ? (
              <p className="text-muted-foreground/60 italic">—</p>
            ) : (
              <dl className="space-y-0.5">
                {rows.map((r) => (
                  <div key={r.k} className="flex gap-1.5 min-w-0">
                    <dt className="text-muted-foreground shrink-0">{r.k}:</dt>
                    <dd className="font-medium text-foreground truncate" title={r.v}>{r.v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const BESPOKE_RENDERED_TYPES = new Set([
  "agency_change", "price_change", "status_change", "first_seen",
  "agent_email_discovered", "agent_mobile_discovered",
  "agent_email_changed", "agent_mobile_changed",
  "listing_auction_scheduled", "sold_date_captured",
  "listing_floorplan_added", "listing_video_added",
  "listing_withdrawn", "listing_relisted",
  "agency_contact_discovered",
]);

function renderEntryDetail(entry) {
  const prevVal = entry.previous_value;
  const newVal = entry.new_value;
  switch (entry.event_type) {
    case "agency_change":             return <AgencyChangeDetail prevVal={prevVal} newVal={newVal} />;
    case "price_change":              return <PriceChangeDetail prevVal={prevVal} newVal={newVal} />;
    case "status_change":             return <StatusChangeDetail prevVal={prevVal} newVal={newVal} />;
    case "first_seen":                return <FirstSeenDetail newVal={newVal} />;
    case "agent_email_discovered":    return <ContactDiscoveredDetail newVal={newVal} kind="email" source={entry.source} />;
    case "agent_mobile_discovered":   return <ContactDiscoveredDetail newVal={newVal} kind="mobile" source={entry.source} />;
    case "agent_email_changed":       return <ContactChangedDetail prevVal={prevVal} newVal={newVal} kind="email" />;
    case "agent_mobile_changed":      return <ContactChangedDetail prevVal={prevVal} newVal={newVal} kind="mobile" />;
    case "listing_auction_scheduled": return <AuctionScheduledDetail newVal={newVal} />;
    case "sold_date_captured":        return <SoldDateCapturedDetail newVal={newVal} />;
    case "listing_floorplan_added":   return <MediaAddedDetail newVal={newVal} kind="floorplan" />;
    case "listing_video_added":       return <MediaAddedDetail newVal={newVal} kind="video" />;
    case "listing_withdrawn":         return <WithdrawnDetail newVal={newVal} />;
    case "listing_relisted":          return <RelistedDetail prevVal={prevVal} newVal={newVal} />;
    case "agency_contact_discovered": return <AgencyContactDiscoveredDetail newVal={newVal} />;
    default:
      if (BESPOKE_RENDERED_TYPES.has(entry.event_type)) return null;
      return <GenericPrevNewDetail prevVal={prevVal} newVal={newVal} />;
  }
}

/* ── Main component ──────────────────────────────────────────────────────── */

export default function PulseTimeline({
  entries = [],
  // legacy prop — kept for API stability; name resolution now prefers entityNameMap
  // eslint-disable-next-line no-unused-vars
  showEntityName = false,
  maxHeight = "max-h-[600px]",
  emptyMessage = "No timeline events yet",
  compact = false,
  onOpenEntity,
  showFilters,            // default depends on compact
  showSourceDrill = true,
  virtualize,             // undefined → auto
  entityNameMap = {},
  defaultCategory = "all",
  onOpenSyncLog,
}) {
  // Filter/search toolbar only rendered when not compact (unless caller overrides)
  const filtersVisible = showFilters == null ? !compact : showFilters;

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(defaultCategory);

  // Compact-mode system filter (same as legacy behavior)
  const compactFiltered = useMemo(() => {
    if (!compact) return entries;
    return entries.filter(e => !SYSTEM_EVENT_TYPES.has(e.event_type));
  }, [entries, compact]);

  // Auto-resolve entity names unless caller supplied their own map.
  // Skip the fetch entirely when callers pass entityNameMap — avoids duplicate
  // network work on surfaces that already have names in scope (dossier).
  const autoNames = useEntityNameMap(
    Object.keys(entityNameMap).length > 0 ? [] : compactFiltered,
  );
  const effectiveNameMap = useMemo(
    () => (Object.keys(entityNameMap).length > 0 ? entityNameMap : autoNames),
    [entityNameMap, autoNames],
  );

  // Toolbar filters (only when toolbar is shown)
  const visibleEntries = useMemo(() => {
    let rows = compactFiltered;
    if (filtersVisible) {
      if (category !== "all") {
        rows = rows.filter(r => (configFor(r.event_type).category || "other") === category);
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        rows = rows.filter(r =>
          (r.title || "").toLowerCase().includes(q) ||
          (r.description || "").toLowerCase().includes(q) ||
          (r.source || "").toLowerCase().includes(q) ||
          (r.event_type || "").toLowerCase().includes(q),
        );
      }
    }
    return rows;
  }, [compactFiltered, filtersVisible, category, search]);

  // Source-drill drawer state (shared across all rows)
  const [drillSource, setDrillSource] = useState(null);   // {source, createdAt} | null
  const handleOpenSourceDrill = showSourceDrill
    ? (source, createdAt) => setDrillSource({ source, createdAt })
    : undefined;

  // Virtualization — auto-enable when >100 rows, unless overridden. Because
  // our rows have variable heights, we use a ref-measured estimate.
  const shouldVirtualize = virtualize != null ? virtualize : visibleEntries.length > 100;
  const scrollRef = useRef(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (compact ? 52 : 140),
    overscan: 10,
    enabled: shouldVirtualize,
  });

  // Helper to build entity pill name from the resolved map (or fall back)
  const lookupName = (entry) => {
    if (!entry.entity_type || !entry.pulse_entity_id) return null;
    return effectiveNameMap[`${entry.entity_type}:${entry.pulse_entity_id}`] || null;
  };

  /* ── Empty state ─────────────────────────────────────────────────────── */
  if (visibleEntries.length === 0) {
    return (
      <div className="space-y-2">
        {filtersVisible && (
          <TimelineToolbar
            search={search} setSearch={setSearch}
            category={category} setCategory={setCategory}
            total={compactFiltered.length}
          />
        )}
        <div className={cn("text-center", compact ? "py-4" : "py-8")}>
          <Clock className={cn("text-muted-foreground/30 mx-auto mb-2", compact ? "h-5 w-5" : "h-8 w-8")} />
          <p className={cn("text-muted-foreground/50", compact ? "text-[10px]" : "text-sm")}>
            {compactFiltered.length === 0
              ? emptyMessage
              : (search || category !== "all")
                  ? "No events match the current filter"
                  : emptyMessage}
          </p>
          {filtersVisible && (search || category !== "all") && (
            <Button
              variant="ghost" size="sm" className="mt-2 h-6 text-[10px]"
              onClick={() => { setSearch(""); setCategory("all"); }}
            >
              Clear filters
            </Button>
          )}
        </div>
      </div>
    );
  }

  /* ── Virtualized render ───────────────────────────────────────────────── */
  if (shouldVirtualize) {
    return (
      <div className="space-y-2">
        {filtersVisible && (
          <TimelineToolbar
            search={search} setSearch={setSearch}
            category={category} setCategory={setCategory}
            total={compactFiltered.length} filtered={visibleEntries.length}
          />
        )}
        <div ref={scrollRef} className={cn("overflow-y-auto relative", maxHeight)}>
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = visibleEntries[virtualRow.index];
              if (!entry) return null;
              return (
                <div
                  key={entry.id || virtualRow.index}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <TimelineRow
                    entry={entry}
                    entityName={lookupName(entry)}
                    onOpenEntity={onOpenEntity}
                    onOpenSourceDrill={handleOpenSourceDrill}
                    onOpenSyncLog={onOpenSyncLog}
                    compact={compact}
                    renderDetail={renderEntryDetail}
                    isLast={virtualRow.index === visibleEntries.length - 1}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <SourceDrillDrawer
          source={drillSource?.source}
          createdAt={drillSource?.createdAt}
          open={!!drillSource}
          onClose={() => setDrillSource(null)}
        />
      </div>
    );
  }

  /* ── Non-virtualized (grouped by month) render ─────────────────────────── */
  const grouped = groupByMonth(visibleEntries);

  return (
    <div className="space-y-2">
      {filtersVisible && (
        <TimelineToolbar
          search={search} setSearch={setSearch}
          category={category} setCategory={setCategory}
          total={compactFiltered.length} filtered={visibleEntries.length}
        />
      )}
      <div className={cn("overflow-y-auto", maxHeight)}>
        {grouped.map(([key, group]) => (
          <div key={key} className={compact ? "mb-2" : "mb-4"}>
            <div className={cn(
              "sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-1 mb-1",
              compact ? "py-0.5" : "py-1.5 mb-2"
            )}>
              <p className={cn(
                "font-semibold text-muted-foreground uppercase tracking-wider",
                compact ? "text-[8px]" : "text-[10px]"
              )}>{group.label}</p>
            </div>
            <div className="space-y-0">
              {group.entries.map((entry, i) => (
                <TimelineRow
                  key={entry.id || i}
                  entry={entry}
                  entityName={lookupName(entry)}
                  onOpenEntity={onOpenEntity}
                  onOpenSourceDrill={handleOpenSourceDrill}
                  onOpenSyncLog={onOpenSyncLog}
                  compact={compact}
                  renderDetail={renderEntryDetail}
                  isLast={i === group.entries.length - 1}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <SourceDrillDrawer
        source={drillSource?.source}
        createdAt={drillSource?.createdAt}
        open={!!drillSource}
        onClose={() => setDrillSource(null)}
      />
    </div>
  );
}

/* ── Filter + search toolbar (only rendered when showFilters is true) ───── */
function TimelineToolbar({ search, setSearch, category, setCategory, total, filtered }) {
  const showResultCount = filtered != null && filtered !== total;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[160px] max-w-sm">
        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, description, source…"
          className="h-7 text-xs pl-7 pr-7"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <Select value={category} onValueChange={setCategory}>
        <SelectTrigger className="h-7 text-xs w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CATEGORY_FILTER_OPTIONS.map(opt => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-[10px] text-muted-foreground tabular-nums ml-auto">
        {showResultCount ? `${filtered} of ${total}` : `${total} events`}
      </span>
    </div>
  );
}

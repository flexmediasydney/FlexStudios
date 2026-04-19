/**
 * PulseAgencyIntel — Agency Intelligence Tab
 * REA-only. Tabular agency roster with live agent counts, full-detail slideout.
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createPageUrl } from "@/utils";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Building2,
  Star,
  ExternalLink,
  Phone,
  Mail,
  MapPin,
  Globe,
  Users,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Hash,
  Home,
  ChevronUp,
  ChevronDown,
  X,
  Activity,
  UserPlus,
  Download,
  Clock,
  Loader2,
  History,
  BarChart3,
  Copy,
  Check,
  Map as MapIcon,
  AlertTriangle,
} from "lucide-react";
import PulseTimeline from "@/components/pulse/PulseTimeline";
import EntitySyncHistoryDialog from "@/components/pulse/EntitySyncHistoryDialog";
import {
  displayPrice as sharedDisplayPrice,
  LISTING_TYPE_LABEL,
  listingTypeBadgeClasses,
  reaIdEquals,
  alternateContacts,
  primaryContact,
} from "@/components/pulse/utils/listingHelpers";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  return v >= 1_000_000
    ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
    ? `$${Math.round(v / 1_000)}K`
    : `$${v}`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function normAgencyKey(s) {
  return (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Compute an agency's average agent rating from its roster, weighted by
 * review count. Used as a fallback when `agency.avg_agent_rating` is null —
 * that column is only ~9% populated, so most agencies would show "—" without
 * this fallback.
 */
function computeAgencyRating(agents) {
  if (!Array.isArray(agents)) return null;
  const weighted = agents
    .filter((a) => a && a.reviews_avg > 0 && a.reviews_count > 0)
    .map((a) => ({ r: a.reviews_avg * a.reviews_count, c: a.reviews_count }));
  if (weighted.length === 0) return null;
  const sumR = weighted.reduce((s, w) => s + w.r, 0);
  const sumC = weighted.reduce((s, w) => s + w.c, 0);
  return sumC > 0 ? +(sumR / sumC).toFixed(2) : null;
}

/**
 * Resolve roster agents for an agency from a pulseAgents list. Mirrors the
 * lookup logic inside the slideout's useMemo roster, but standalone so the
 * table cell renderer can use it per-row without extra hooks.
 */
function rosterForAgency(agency, pulseAgents) {
  if (!agency || !Array.isArray(pulseAgents)) return [];
  if (agency.rea_agency_id) {
    const byId = pulseAgents.filter((a) => a.agency_rea_id === agency.rea_agency_id);
    if (byId.length > 0) return byId;
  }
  const key = normAgencyKey(agency.name);
  if (!key) return [];
  return pulseAgents.filter((a) => normAgencyKey(a.agency_name) === key);
}

function fmtAgo(d) {
  if (!d) return "—";
  const t = new Date(d).getTime();
  if (isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d2 = Math.floor(h / 24);
  if (d2 < 30) return `${d2}d ago`;
  const mo = Math.floor(d2 / 30);
  return `${mo}mo ago`;
}

function exportCsv(filename, header, rows, { bom = false } = {}) {
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(","));
  // #29: UTF-8 BOM so Excel autodetects encoding on non-ASCII agent names.
  const body = (bom ? "\uFEFF" : "") + lines.join("\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseArray(val) {
  if (!val) return [];
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Convert a hex color (#RRGGBB or #RGB) to an `rgba(...)` string with the
 * given alpha. Returns null if the input isn't parseable — callers should
 * fall through to a neutral fallback in that case. Alpha is clamped 0..1.
 */
function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== "string") return null;
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * #27: normalised name for duplicate detection. Strips common agency
 * suffixes + punctuation/whitespace so "Ray White Bondi Pty Ltd" and
 * "Ray White Bondi" collapse to the same key.
 */
function normAgencyNameForDupe(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[.,&'"`]/g, " ")
    .replace(/\b(pty ltd|pty|ltd|limited|llc|inc|group|agency|realty|real estate|co|company)\b/g, "")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * #25: rank suburbs by listing count from an agency's listings. Returns
 * [{ suburb, count }, ...] sorted desc.
 */
function computeSuburbRanking(listings) {
  if (!Array.isArray(listings) || listings.length === 0) return [];
  const counts = new Map();
  for (const l of listings) {
    const s = (l?.suburb || "").trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([suburb, count]) => ({ suburb, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Aggregate per-property-type sales_breakdown across an agency's roster.
 * Each pulse_agent row carries its own jsonb like:
 *   { house: { count, medianSoldPrice, medianDaysOnSite }, ... }
 * We sum counts across agents and take the weighted-by-count mean of
 * medianSoldPrice / medianDaysOnSite. pulse_agencies has no sales_breakdown
 * column (0% populated), so this client-side rollup is the only source.
 */
function aggregateRosterSalesBreakdown(roster) {
  if (!Array.isArray(roster) || roster.length === 0) return null;
  const agg = {};
  for (const ag of roster) {
    let sb = ag?.sales_breakdown;
    if (!sb) continue;
    if (typeof sb === "string") {
      try { sb = JSON.parse(sb); } catch { sb = null; }
    }
    if (!sb || typeof sb !== "object") continue;
    for (const [type, data] of Object.entries(sb)) {
      if (!data || typeof data !== "object") continue;
      const c = Number(data.count) || 0;
      if (c <= 0) continue;
      if (!agg[type]) agg[type] = { count: 0, _priceSum: 0, _priceW: 0, _domSum: 0, _domW: 0 };
      agg[type].count += c;
      if (data.medianSoldPrice > 0) {
        agg[type]._priceSum += Number(data.medianSoldPrice) * c;
        agg[type]._priceW += c;
      }
      if (data.medianDaysOnSite > 0) {
        agg[type]._domSum += Number(data.medianDaysOnSite) * c;
        agg[type]._domW += c;
      }
    }
  }
  const out = {};
  for (const [type, v] of Object.entries(agg)) {
    out[type] = {
      count: v.count,
      medianSoldPrice: v._priceW > 0 ? Math.round(v._priceSum / v._priceW) : null,
      medianDaysOnSite: v._domW > 0 ? +(v._domSum / v._domW).toFixed(1) : null,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/* Roster sort options — photography pitch is "who's shooting a lot right now?",
   so Active listings is the default. Values mirror the most useful columns
   available on pulse_agents. */
const ROSTER_SORT_OPTIONS = [
  { value: "active", label: "Active listings" },
  { value: "sold", label: "Sold (12m)" },
  { value: "rating", label: "Rating" },
  { value: "name", label: "Name" },
];
const ROSTER_SORT_DEFAULT = "active";

function sortRoster(list, sortKey) {
  if (!Array.isArray(list)) return [];
  const arr = list.slice();
  switch (sortKey) {
    case "sold":
      arr.sort((a, b) => (b.sales_as_lead || b.total_sold_12m || 0) - (a.sales_as_lead || a.total_sold_12m || 0));
      break;
    case "rating":
      arr.sort((a, b) => (b.rea_rating || b.reviews_avg || 0) - (a.rea_rating || a.reviews_avg || 0));
      break;
    case "name":
      arr.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
      break;
    case "active":
    default:
      arr.sort((a, b) => (b.total_listings_active || 0) - (a.total_listings_active || 0));
      break;
  }
  return arr;
}

function mapPosition(jobTitle) {
  const jt = (jobTitle || "").toLowerCase();
  if (
    jt.includes("principal") ||
    jt.includes("director") ||
    jt.includes("managing") ||
    jt.includes("licensee") ||
    jt.includes("owner") ||
    jt.includes("ceo") ||
    jt.includes("partner")
  )
    return "Partner";
  if (
    jt.includes("senior") ||
    jt.includes("manager") ||
    jt.includes("head of") ||
    jt.includes("auctioneer")
  )
    return "Senior";
  return jt.includes("associate") ? "Associate" : "Junior";
}

function positionColor(pos) {
  if (pos === "Partner")
    return "text-blue-600 border-blue-200 dark:text-blue-400 dark:border-blue-800";
  if (pos === "Senior")
    return "text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-800";
  if (pos === "Associate")
    return "text-violet-600 border-violet-200 dark:text-violet-400 dark:border-violet-800";
  return "text-gray-500 border-gray-200 dark:text-gray-400 dark:border-gray-800";
}

/* ── Small shared UI atoms ────────────────────────────────────────────────── */

const REABadge = () => (
  <span className="text-[7px] font-bold uppercase px-1 py-0 rounded inline-block leading-relaxed bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
    REA
  </span>
);

/* AG11: compact contact provenance chip row. */
function ContactProvBadges({ info }) {
  if (!info || !info.value) return null;
  const isDetail = typeof info.source === "string" && info.source.startsWith("detail_page_");
  const parts = [];
  if (info.verified) parts.push(
    <span key="v" title={`Verified across ${info.sourcesCount || 2}+ sources`}
      className="inline-flex items-center text-[8px] font-semibold uppercase px-1 py-0 rounded text-emerald-700 bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-800/40">v</span>
  );
  if (isDetail) parts.push(
    <span key="d" title="From listing detail page"
      className="inline-flex items-center text-[8px] font-semibold uppercase px-1 py-0 rounded text-indigo-700 bg-indigo-50 border border-indigo-200 dark:bg-indigo-950/20 dark:text-indigo-400 dark:border-indigo-800/40">d</span>
  );
  if (info.stale) parts.push(
    <span key="s" title="Last seen > 90 days ago"
      className="inline-flex items-center text-[8px] font-semibold uppercase px-1 py-0 rounded text-amber-700 bg-amber-50 border border-amber-200 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-800/40">stale</span>
  );
  if (parts.length === 0) return null;
  return <span className="inline-flex items-center gap-0.5 ml-1">{parts}</span>;
}

/* #30: inline address cluster — text + Copy + "Open in Maps" icon. */
function AddressCluster({ address, className }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  const doCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };
  const mapsHref = `https://www.google.com/maps?q=${encodeURIComponent(address)}`;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
      <span className="truncate">{address}</span>
      <button type="button" onClick={doCopy}
        title={copied ? "Copied!" : "Copy address"}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
      <a href={mapsHref} target="_blank" rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Open in Google Maps"
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
        <MapIcon className="h-3 w-3" />
      </a>
    </span>
  );
}

const SortIcon = ({ col, current, dir }) => {
  if (current !== col)
    return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40 ml-0.5 inline" />;
  return dir === "asc" ? (
    <ChevronUp className="h-3 w-3 text-primary ml-0.5 inline" />
  ) : (
    <ChevronDown className="h-3 w-3 text-primary ml-0.5 inline" />
  );
};

const StarRating = ({ value }) => {
  if (!value || value <= 0) return <span className="text-muted-foreground/50">—</span>;
  return (
    <span className="flex items-center gap-0.5">
      <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
      <span>{Number(value).toFixed(1)}</span>
    </span>
  );
};

const CrmBadge = ({ inCrm }) =>
  inCrm ? (
    <Badge className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 border-0 dark:bg-emerald-900/30 dark:text-emerald-400">
      In CRM
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="text-[9px] px-1.5 py-0 text-muted-foreground border-dashed"
    >
      Not in CRM
    </Badge>
  );

/* #31: StatBox now accepts an optional brand color for 3px left border. */
const StatBox = ({ label, value, sub, brandColor, title }) => (
  <div
    className="bg-muted/40 rounded-lg p-3 text-center"
    style={brandColor ? { borderLeft: `3px solid ${brandColor}` } : undefined}
    title={title}
  >
    <p className="text-lg font-bold tabular-nums leading-none">{value}</p>
    {sub && <p className="text-[9px] text-primary mt-0.5">{sub}</p>}
    <p className="text-[9px] text-muted-foreground mt-0.5">{label}</p>
  </div>
);

/* ── Listing row ─────────────────────────────────────────────────────────── */

const ListingRow = ({ l, onOpen }) => {
  const isSold = l.listing_type === "sold";
  const isRent = l.listing_type === "for_rent";
  const isUnderContract = l.listing_type === "under_contract";

  // Shared canonical price label — handles sold / for_rent / under_contract
  // ordering + the /wk suffix consistently. Previous inline branches diverged.
  const priceLabel = sharedDisplayPrice(l).label;

  // Body row content — shared between onOpen and link variants.
  const bodyMeta = (
    <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
      {l.suburb && <span>{l.suburb}</span>}
      {isSold ? (
        <>
          {priceLabel && priceLabel !== "—" && (
            <span className="font-medium text-foreground">{priceLabel}</span>
          )}
          {l.sold_date && (
            <span className="text-[9px]">Sold {fmtDate(l.sold_date)}</span>
          )}
        </>
      ) : (
        <>
          {priceLabel && priceLabel !== "—" && (
            <span className="font-medium text-foreground">{priceLabel}</span>
          )}
          {l.bedrooms > 0 && <span>{l.bedrooms}bd</span>}
          {l.bathrooms > 0 && <span>{l.bathrooms}ba</span>}
        </>
      )}
    </div>
  );

  // Status badges — render one branch per state. under_contract uses amber
  // classes from the shared listingTypeBadgeClasses helper.
  const statusBadges = (
    <>
      {isSold && (
        <Badge className="text-[7px] py-0 px-1 bg-emerald-100 text-emerald-700 border-0">
          Sold
        </Badge>
      )}
      {isRent && (
        <Badge
          variant="outline"
          className="text-[7px] py-0 px-1 text-purple-600 border-purple-200"
        >
          Rent
        </Badge>
      )}
      {isUnderContract && (() => {
        const c = listingTypeBadgeClasses("under_contract");
        return (
          <Badge
            variant="outline"
            className={cn("text-[7px] py-0 px-1", c.text, c.border)}
          >
            {LISTING_TYPE_LABEL.under_contract}
          </Badge>
        );
      })()}
    </>
  );

  if (onOpen) {
    return (
      <button
        onClick={() => onOpen(l)}
        className="w-full flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors text-left"
      >
        {l.image_url ? (
          <img
            src={l.image_url}
            alt=""
            className="h-9 w-14 object-cover rounded shrink-0"
          />
        ) : (
          <div className="h-9 w-14 bg-muted rounded shrink-0 flex items-center justify-center">
            <Home className="h-3.5 w-3.5 text-muted-foreground/40" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{l.address || l.suburb || "—"}</p>
          {bodyMeta}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {statusBadges}
          {!isSold && !isRent && !isUnderContract && (
            <ChevronRight className="h-3 w-3 text-primary" />
          )}
        </div>
      </button>
    );
  }

  return (
    <a
      href={l.source_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors"
    >
      {l.image_url ? (
        <img
          src={l.image_url}
          alt=""
          className="h-9 w-14 object-cover rounded shrink-0"
        />
      ) : (
        <div className="h-9 w-14 bg-muted rounded shrink-0 flex items-center justify-center">
          <Home className="h-3.5 w-3.5 text-muted-foreground/40" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{l.address || l.suburb || "—"}</p>
        {bodyMeta}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {statusBadges}
        {!isSold && !isRent && !isUnderContract && (
          <ExternalLink className="h-3 w-3 text-primary" />
        )}
      </div>
    </a>
  );
};

/* ── Agent row (within slideout) ─────────────────────────────────────────── */

const AgentRow = ({
  agent,
  isInCrm,
  isSelected,
  onSelect,
  crmEntityId,
  selectable = false,
  checked = false,
  onToggleChecked,
}) => {
  const pos = mapPosition(agent.job_title);
  return (
    <button
      onClick={() => onSelect(isSelected ? null : agent)}
      className={cn(
        "w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors hover:bg-muted/40",
        isSelected && "bg-muted/60 ring-1 ring-primary/20"
      )}
    >
      {/* #28: checkbox appears only when the row is selectable (uncrm'd) */}
      {selectable && (
        <span
          role="checkbox"
          aria-checked={checked}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onToggleChecked?.(agent);
          }}
          className={cn(
            "shrink-0 h-4 w-4 rounded border flex items-center justify-center cursor-pointer transition-colors",
            checked
              ? "bg-primary border-primary text-primary-foreground"
              : "border-border hover:border-primary/60"
          )}
          title={checked ? "Deselect" : "Select for bulk add to CRM"}
        >
          {checked && <Check className="h-3 w-3" />}
        </span>
      )}
      {agent.profile_image ? (
        <img
          src={agent.profile_image}
          alt={agent.full_name}
          className="h-8 w-8 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Users className="h-3.5 w-3.5 text-muted-foreground/40" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium truncate">{agent.full_name || "—"}</span>
          {pos !== "Junior" && (
            <Badge
              variant="outline"
              className={cn("text-[7px] py-0 px-1 shrink-0", positionColor(pos))}
            >
              {pos}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
          {agent.job_title && <span className="truncate max-w-[120px]">{agent.job_title}</span>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0 text-[10px]">
        {(agent.sales_as_lead > 0 || agent.total_listings_active > 0) && (
          <span className="text-muted-foreground tabular-nums">
            {(agent.sales_as_lead || agent.total_sold_12m) > 0 && `${agent.sales_as_lead || agent.total_sold_12m} sold`}
            {agent.total_listings_active > 0 && ` · ${agent.total_listings_active} active`}
          </span>
        )}
        {agent.avg_sold_price > 0 && (
          <span className="font-medium text-foreground">{fmtPrice(agent.avg_sold_price)}</span>
        )}
        {(agent.rea_rating || agent.reviews_avg) > 0 && (
          <span className="flex items-center gap-0.5 text-amber-500">
            <Star className="h-2.5 w-2.5 fill-amber-400" />
            {Number(agent.rea_rating || agent.reviews_avg).toFixed(1)}
          </span>
        )}
        <CrmBadge inCrm={!!isInCrm} />
        {isInCrm && crmEntityId && (
          <Link
            to={createPageUrl("PersonDetails") + `?id=${crmEntityId}`}
            replace={false}
            onClick={(e) => e.stopPropagation()}
            className="text-primary hover:underline text-[9px] flex items-center gap-0.5"
            title="View in CRM"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        )}
      </div>
    </button>
  );
};

/* ── Mini agent profile (inline, within slideout) ────────────────────────── */

const AgentMiniProfile = ({ agent, onClose }) => {
  const pos = mapPosition(agent.job_title);
  return (
    <div className="mt-2 p-3 rounded-xl border bg-card shadow-sm animate-in slide-in-from-top-1 duration-150">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          {agent.profile_image ? (
            <img
              src={agent.profile_image}
              alt={agent.full_name}
              className="h-12 w-12 rounded-full object-cover shrink-0"
            />
          ) : (
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center shrink-0">
              <Users className="h-5 w-5 text-muted-foreground/40" />
            </div>
          )}
          <div>
            <p className="font-semibold text-sm">{agent.full_name || "—"}</p>
            {agent.job_title && (
              <p className="text-xs text-muted-foreground">{agent.job_title}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {pos !== "Junior" && (
                <Badge
                  variant="outline"
                  className={cn("text-[7px] py-0 px-1", positionColor(pos))}
                >
                  {pos}
                </Badge>
              )}
              <REABadge />
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted transition-colors shrink-0"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <StatBox label="Sold (12m)" value={agent.sales_as_lead > 0 ? agent.sales_as_lead : "—"} />
        <StatBox
          label="Avg Price"
          value={fmtPrice(agent.avg_sold_price)}
        />
        <StatBox
          label="Rating"
          value={
            (agent.rea_rating || agent.reviews_avg) > 0 ? (
              <span className="flex items-center justify-center gap-0.5">
                <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
                {Number(agent.rea_rating || agent.reviews_avg).toFixed(1)}
              </span>
            ) : (
              "—"
            )
          }
        />
      </div>

      <div className="flex flex-wrap gap-2 mt-3 text-xs">
        {(agent.mobile || agent.business_phone) && (
          <a
            href={`tel:${agent.mobile || agent.business_phone}`}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Phone className="h-3 w-3" />
            {agent.mobile || agent.business_phone}
          </a>
        )}
        {agent.email && (
          <a
            href={`mailto:${agent.email}`}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Mail className="h-3 w-3" />
            {agent.email}
          </a>
        )}
        {agent.rea_profile_url && (
          <a
            href={agent.rea_profile_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-red-500 hover:text-red-600 transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            REA Profile
          </a>
        )}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ═══ AGENCY SLIDEOUT ══════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════ */

export function AgencySlideout({
  agency,
  pulseAgents,
  pulseListings,
  pulseTimeline,
  crmAgencies,
  pulseMappings,
  pulseAgencies,
  onClose,
  onOpenEntity,
  hasHistory = false,
  onBack,
}) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [addingToCrm, setAddingToCrm] = useState(false);
  // Tier 4: source-history drill
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
  // AG05: roster sort
  const [rosterSort, setRosterSort] = useState(ROSTER_SORT_DEFAULT);
  // #25: "Show all" toggle for suburb concentration ranking
  const [showAllSuburbs, setShowAllSuburbs] = useState(false);
  // #28: bulk-select set of pulse_agent ids (uncrm'd only).
  const [selectedAgentIds, setSelectedAgentIds] = useState(() => new Set());
  const [bulkAddingToCrm, setBulkAddingToCrm] = useState(false);
  const navigate = useNavigate();

  // Fetch per-agency timeline via the dossier RPC — the global `pulseTimeline`
  // prop is capped at 500 rows across the platform, so for most agencies it
  // missed every event they'd ever had. The RPC fans out to their listings'
  // events too. See companion fix in AgentSlideout.
  const { data: agencyDossier } = useQuery({
    queryKey: ["pulse_dossier_slideout", "agency", agency?.id],
    queryFn: async () => {
      if (!agency?.id) return null;
      const { data, error } = await api._supabase.rpc("pulse_get_dossier", {
        p_entity_type: "agency",
        p_entity_id: agency.id,
      });
      if (error) throw error;
      return data;
    },
    enabled: !!agency?.id,
    staleTime: 30_000,
  });
  const slideoutTimeline = useMemo(() => {
    if (agencyDossier?.timeline?.length) return agencyDossier.timeline;
    return (pulseTimeline || []).filter(e =>
      reaIdEquals(e.rea_id, agency?.rea_agency_id) ||
      e.pulse_entity_id === agency?.id
    );
  }, [agencyDossier, pulseTimeline, agency]);

  /* Check if already in CRM */
  const existingCrmAgency = useMemo(
    () => crmAgencies.find((c) => normAgencyKey(c.name) === normAgencyKey(agency?.name)),
    [crmAgencies, agency]
  );

  /* Tier 3 drill-through: look up CRM mapping so the "In CRM" badge links to
     the CRM Organisation record (OrgDetails). */
  const crmAgencyMapping = useMemo(() => {
    if (!agency?.is_in_crm || !pulseMappings) return null;
    return pulseMappings.find(
      (m) =>
        m.entity_type === "agency" &&
        (m.pulse_entity_id === agency.id ||
          (m.rea_id && agency.rea_agency_id && String(m.rea_id) === String(agency.rea_agency_id)))
    );
  }, [agency, pulseMappings]);

  /* Add agency to CRM handler */
  async function handleAddAgencyToCrm() {
    if (!agency) return;
    setAddingToCrm(true);
    try {
      const newAgency = await api.entities.Agency.create({
        name: agency.name,
        phone: agency.phone || null,
        email: agency.email || null,
        website: agency.website || null,
        rea_agency_id: agency.rea_agency_id || null,
        source: "pulse",
        relationship_state: "Prospecting",
      });

      // Create mapping
      await api.entities.PulseCrmMapping.create({
        entity_type: "agency",
        pulse_entity_id: agency.id,
        crm_entity_id: newAgency.id,
        rea_id: agency.rea_agency_id,
        match_type: "manual",
        confidence: "confirmed",
      });

      // Mark pulse agency as in_crm
      await api.entities.PulseAgency.update(agency.id, { is_in_crm: true });

      await refetchEntityList("PulseAgency");
      await refetchEntityList("Agency");
      await refetchEntityList("PulseCrmMapping");

      toast.success(`${agency.name} added to CRM`);
      onClose();
    } catch (err) {
      console.error("Add agency to CRM failed:", err);
      toast.error("Failed to add agency to CRM. Please try again.");
    } finally {
      setAddingToCrm(false);
    }
  }

  /* Look up CRM entity ID for an agent via mappings */
  function getCrmEntityIdForAgent(pulseAgent) {
    if (!pulseAgent || !pulseMappings) return null;
    const mapping = pulseMappings.find(
      (m) =>
        m.entity_type === "agent" &&
        (m.pulse_entity_id === pulseAgent.id ||
          (m.rea_id && m.rea_id === pulseAgent.rea_agent_id))
    );
    return mapping?.crm_entity_id || null;
  }

  /* roster — AG05: apply user-selected sort (default: Active listings).
     Prefers the server-side dossier roster (includes CRM mapping join) and
     falls back to the pulseAgents prop when the dossier hasn't resolved yet.
     Post big-refactor pulseAgents is empty at page level, so the dossier is
     the only populated path in practice. */
  const roster = useMemo(() => {
    if (!agency) return [];
    if (Array.isArray(agencyDossier?.agency_roster) && agencyDossier.agency_roster.length > 0) {
      return sortRoster(agencyDossier.agency_roster, rosterSort);
    }
    let base = [];
    if (agency.rea_agency_id) {
      base = pulseAgents.filter((a) => a.agency_rea_id === agency.rea_agency_id);
    }
    if (base.length === 0) {
      const key = normAgencyKey(agency.name);
      if (key) base = pulseAgents.filter((a) => normAgencyKey(a.agency_name) === key);
    }
    return sortRoster(base, rosterSort);
  }, [agency, pulseAgents, rosterSort, agencyDossier]);

  /* AG06: aggregate sales_breakdown from roster — pulse_agencies has no
     sales_breakdown column, so we roll up per-agent sales_breakdown jsonb
     client-side. Rendered as a mini chart mirroring the agent dossier. */
  const rosterSalesBreakdown = useMemo(
    () => aggregateRosterSalesBreakdown(roster),
    [roster]
  );

  /* CRM lookup for agents */
  const crmAgentIds = useMemo(() => {
    const s = new Set();
    /* We don't have CRM agent data here so we rely on is_in_crm flag on pulseAgent */
    roster.forEach((a) => {
      if (a.is_in_crm) s.add(a.id);
    });
    return s;
  }, [roster]);

  /* listings — prefer server-side dossier listings (same table, pre-filtered
     to this agency and its roster). Fallback kept for the window where the
     slideout mounts before the RPC resolves. Post big-refactor pulseListings
     is empty at page level so the dossier is effectively the only source. */
  const agencyListings = useMemo(() => {
    if (!agency) return [];
    if (Array.isArray(agencyDossier?.listings) && agencyDossier.listings.length > 0) {
      return agencyDossier.listings;
    }
    if (agency.rea_agency_id) {
      const byId = pulseListings.filter(
        (l) => l.agency_rea_id === agency.rea_agency_id
      );
      if (byId.length > 0) return byId;
    }
    /* Fallback: check if listing's agent belongs to this agency's roster */
    const rosterIds = new Set(roster.map((a) => a.rea_agent_id).filter(Boolean));
    const byAgent = pulseListings.filter(
      (l) => l.agent_rea_id && rosterIds.has(l.agent_rea_id)
    );
    if (byAgent.length > 0) return byAgent;
    /* Last resort: normalized name match on listing.agency_name */
    const key = normAgencyKey(agency.name);
    if (key) return pulseListings.filter((l) => normAgencyKey(l.agency_name) === key);
    return [];
  }, [agency, pulseListings, roster, agencyDossier]);

  const forSale = agencyListings.filter((l) => l.listing_type === "for_sale").slice(0, 10);
  const forRent = agencyListings.filter((l) => l.listing_type === "for_rent").slice(0, 10);
  const sold = agencyListings.filter((l) => l.listing_type === "sold").slice(0, 10);

  /* suburbs */
  const suburbs = useMemo(() => parseArray(agency?.suburbs_active), [agency]);

  /* #25: suburb concentration — ranked by listing count */
  const suburbRanking = useMemo(() => computeSuburbRanking(agencyListings), [agencyListings]);

  /* #27: duplicate agency detector — groups by normalised (suffix-stripped)
     name. Only highlights rows that clash with the currently-open agency. */
  const duplicates = useMemo(() => {
    if (!agency?.name || !Array.isArray(pulseAgencies)) return [];
    const myKey = normAgencyNameForDupe(agency.name);
    if (!myKey) return [];
    return pulseAgencies.filter(
      (o) => o && o.id !== agency.id && normAgencyNameForDupe(o.name) === myKey
    );
  }, [agency, pulseAgencies]);

  useEffect(() => {
    if (duplicates.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[PulseAgencyIntel #27] Possible duplicate of "${agency.name}":`,
        duplicates.map((d) => ({ id: d.rea_agency_id, name: d.name }))
      );
    }
  }, [duplicates, agency]);

  const isInCrm = !!agency?.is_in_crm;

  /* #28: toggle a single agent in the bulk-select set (uncrm'd only). */
  const toggleAgentSelection = useCallback((ag) => {
    if (!ag || ag.is_in_crm) return;
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(ag.id)) next.delete(ag.id);
      else next.add(ag.id);
      return next;
    });
  }, []);

  /* #28: bulk add selected agents to CRM. Fails-soft per row. */
  const handleBulkAddAgentsToCrm = useCallback(async () => {
    if (selectedAgentIds.size === 0) return;
    setBulkAddingToCrm(true);
    let ok = 0, fail = 0;
    try {
      const agents = roster.filter((a) => !a.is_in_crm && selectedAgentIds.has(a.id));
      for (const ag of agents) {
        try {
          let agencyId = null;
          if (agency?.rea_agency_id) {
            const { data: existing } = await api._supabase
              .from("agencies")
              .select("id")
              .eq("rea_agency_id", agency.rea_agency_id)
              .maybeSingle();
            agencyId = existing?.id || null;
          }
          if (!agencyId && agency?.name) {
            const newAgency = await api.entities.Agency.create({
              name: agency.name,
              rea_agency_id: agency.rea_agency_id || null,
              source: "pulse",
            });
            agencyId = newAgency?.id;
          }
          const newAgent = await api.entities.Agent.create({
            full_name: ag.full_name || "Unknown",
            email: ag.email || null,
            mobile: ag.mobile || null,
            business_phone: ag.business_phone || null,
            job_title: ag.job_title || null,
            current_agency_id: agencyId,
            rea_agent_id: ag.rea_agent_id || null,
            source: "pulse",
          });
          await api.entities.PulseCrmMapping.create({
            entity_type: "agent",
            pulse_entity_id: ag.id,
            crm_entity_id: newAgent.id,
            rea_id: ag.rea_agent_id || null,
            match_type: "manual",
            confidence: "confirmed",
          });
          await api.entities.PulseAgent.update(ag.id, { is_in_crm: true });
          ok += 1;
        } catch (err) {
          console.error(`[#28] Bulk add failed for agent ${ag.id}:`, err);
          fail += 1;
        }
      }
      await refetchEntityList("PulseAgent");
      await refetchEntityList("Agent");
      await refetchEntityList("PulseCrmMapping");
      if (ok > 0) toast.success(`Added ${ok} agent${ok > 1 ? "s" : ""} to CRM${fail > 0 ? ` (${fail} failed)` : ""}`);
      if (ok === 0 && fail > 0) toast.error(`All ${fail} adds failed. Check console.`);
      setSelectedAgentIds(new Set());
    } finally {
      setBulkAddingToCrm(false);
    }
  }, [selectedAgentIds, roster, agency]);

  /* #29: Roster CSV export (UTF-8 BOM). */
  const handleExportRoster = useCallback(() => {
    if (!roster || roster.length === 0) return;
    const header = [
      "full_name", "email", "mobile", "job_title",
      "sales_as_lead", "reviews_avg", "is_in_crm",
    ];
    const rows = roster.map((a) => ({
      full_name: a.full_name || "",
      email: a.email || "",
      mobile: a.mobile || a.business_phone || "",
      job_title: a.job_title || "",
      sales_as_lead: a.sales_as_lead ?? a.total_sold_12m ?? "",
      reviews_avg: a.reviews_avg ?? a.rea_rating ?? "",
      is_in_crm: a.is_in_crm ? "true" : "false",
    }));
    const slug = (agency?.name || "agency")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    exportCsv(
      `roster_${slug}_${new Date().toISOString().slice(0, 10)}.csv`,
      header, rows, { bom: true }
    );
  }, [roster, agency]);

  /* #24: "View all N listings" — deep-link into the Listings tab filtered
     to this agency (clears other filters on arrival). */
  const handleViewAllListings = useCallback(() => {
    if (!agency?.rea_agency_id) return;
    onClose?.();
    navigate(`/IndustryPulse?tab=listings&agency_rea_id=${encodeURIComponent(agency.rea_agency_id)}`);
  }, [agency, navigate, onClose]);

  if (!agency) return null;

  // AG07: brand color accent — top-border + subtle bg tint when
  // brand_color_primary is populated (~7% of agencies). Fallback: no border,
  // neutral bg, identical to legacy behavior.
  const brandAccent = hexToRgba(agency.brand_color_primary, 1);
  const brandTint = hexToRgba(agency.brand_color_primary, 0.06);
  const headerStyle = brandAccent
    ? {
        borderTop: `3px solid ${brandAccent}`,
        backgroundColor: brandTint,
      }
    : undefined;

  return (
    <Dialog open={!!agency} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl w-full max-h-[90vh] overflow-y-auto p-0">
        {/* ── Header (AG07: brand color top-border + subtle tint when set) ── */}
        <div
          className={cn(
            "sticky top-0 z-10 backdrop-blur border-b px-5 py-4",
            brandAccent ? "" : "bg-background/95"
          )}
          style={headerStyle}
        >
          <DialogHeader>
            <DialogTitle asChild>
              <div className="flex items-start gap-3">
                {/* Back */}
                {hasHistory && onBack && (
                  <button
                    onClick={onBack}
                    className="p-1.5 -ml-1 rounded-lg hover:bg-muted transition-colors shrink-0"
                    title="Back"
                  >
                    <ChevronLeft className="h-4 w-4 text-muted-foreground" />
                  </button>
                )}
                {/* Logo — #32: always rounded-full 40px in slideout header */}
                <div className="h-10 w-10 rounded-full overflow-hidden bg-white flex items-center justify-center shrink-0 border">
                  {agency.logo_url ? (
                    <img
                      src={agency.logo_url}
                      alt={agency.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Building2 className="h-5 w-5 text-muted-foreground/40" />
                  )}
                </div>
                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {/* #31: agency name chip — 6% brand bg when populated. */}
                    <h2
                      className="text-base font-bold leading-tight truncate rounded px-1 -mx-1"
                      style={
                        brandAccent
                          ? { backgroundColor: hexToRgba(agency.brand_color_primary, 0.06) }
                          : undefined
                      }
                    >
                      {agency.name || "—"}
                    </h2>
                    <REABadge />
                    {/* Tier 3: when mapped, the In CRM badge links to OrgDetails. */}
                    {isInCrm && crmAgencyMapping?.crm_entity_id ? (
                      <Link
                        to={createPageUrl("OrgDetails") + `?id=${crmAgencyMapping.crm_entity_id}`}
                        replace={false}
                        className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 px-1.5 py-0 text-[9px] font-medium leading-4 hover:underline"
                        title="Open CRM record"
                      >
                        In CRM
                        <ExternalLink className="h-2.5 w-2.5" />
                      </Link>
                    ) : (
                      <CrmBadge inCrm={isInCrm} />
                    )}
                    {/* #27: duplicate warning chip — tooltip lists duplicates */}
                    {duplicates.length > 0 && (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1.5 py-0 text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-800 gap-1"
                        title={
                          "Possible duplicate of:\n" +
                          duplicates
                            .map((d) => `\u2022 ${d.name} (${d.rea_agency_id || d.id})`)
                            .join("\n")
                        }
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        Possible duplicate of {duplicates[0].name}
                        {duplicates.length > 1 ? ` +${duplicates.length - 1}` : ""}
                      </Badge>
                    )}
                  </div>
                  {agency.suburb && (
                    <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {agency.suburb}
                      {agency.state && `, ${agency.state}`}
                    </p>
                  )}
                </div>
                {/* Close */}
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-muted transition-colors shrink-0"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            </DialogTitle>
          </DialogHeader>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* ── Contact ── */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2">
              Contact
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
              {agency.phone && (
                <div className="flex flex-col">
                  <a
                    href={`tel:${agency.phone}`}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Phone className="h-3.5 w-3.5 text-primary" />
                    {agency.phone}
                  </a>
                  {(() => {
                    const alts = alternateContacts(agency, "phone");
                    if (alts.length === 0) return null;
                    return (
                      <details className="mt-1 text-[11px] text-muted-foreground ml-5">
                        <summary className="cursor-pointer hover:text-foreground">
                          +{alts.length} other phone{alts.length > 1 ? "s" : ""}
                        </summary>
                        <ul className="ml-3 mt-1 space-y-0.5">
                          {alts.map((a, i) => (
                            <li key={i}>
                              <a
                                href={`tel:${a.value}`}
                                className="hover:underline"
                              >
                                {a.value}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    );
                  })()}
                </div>
              )}
              {agency.email && (
                <div className="flex flex-col">
                  <a
                    href={`mailto:${agency.email}`}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Mail className="h-3.5 w-3.5 text-primary" />
                    {agency.email}
                  </a>
                  {(() => {
                    const alts = alternateContacts(agency, "email");
                    if (alts.length === 0) return null;
                    return (
                      <details className="mt-1 text-[11px] text-muted-foreground ml-5">
                        <summary className="cursor-pointer hover:text-foreground">
                          +{alts.length} other email{alts.length > 1 ? "s" : ""}
                        </summary>
                        <ul className="ml-3 mt-1 space-y-0.5">
                          {alts.map((a, i) => (
                            <li key={i}>
                              <a
                                href={`mailto:${a.value}`}
                                className="hover:underline"
                              >
                                {a.value}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    );
                  })()}
                </div>
              )}
              {agency.website && (
                <a
                  href={agency.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Globe className="h-3.5 w-3.5 text-primary" />
                  {agency.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              )}
              {(agency.address_street || agency.address) && (
                <AddressCluster
                  address={agency.address_street || agency.address}
                  className="text-muted-foreground"
                />
              )}
              {agency.rea_profile_url && (
                <a
                  href={agency.rea_profile_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-red-500 hover:text-red-600 transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  REA Profile
                </a>
              )}
            </div>
          </section>

          {/* ── Stats grid ── */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2">
              Performance
            </h3>
            <div
              className={cn(
                "grid grid-cols-2 gap-2",
                agency.avg_listing_price > 0 ? "sm:grid-cols-5" : "sm:grid-cols-4"
              )}
            >
              <StatBox
                brandColor={brandAccent || undefined}
                label="Agents"
                value={
                  agency.live_agent_count > 0
                    ? agency.live_agent_count
                    : agency.agent_count || "—"
                }
              />
              <StatBox
                brandColor={brandAccent || undefined}
                label="Active Listings"
                value={agency.active_listings > 0 ? agency.active_listings : "—"}
              />
              <StatBox
                brandColor={brandAccent || undefined}
                label="Sold (12m)"
                value={agency.total_sold_12m > 0 ? agency.total_sold_12m : "—"}
              />
              {agency.avg_listing_price > 0 && (
                <StatBox
                  brandColor={brandAccent || undefined}
                  label="Avg Listing $"
                  value={fmtPrice(agency.avg_listing_price)}
                />
              )}
              {(() => {
                const displayRating =
                  agency.avg_agent_rating ?? computeAgencyRating(roster) ?? null;
                // AG12: show provenance in tooltip when we fell back to roster rating.
                const isFallback =
                  agency.avg_agent_rating == null &&
                  displayRating != null &&
                  roster.length > 0;
                const ratedCount = roster.filter(
                  (a) => (a?.reviews_avg || 0) > 0 && (a?.reviews_count || 0) > 0
                ).length;
                return (
                  <StatBox
                    brandColor={brandAccent || undefined}
                    title={
                      isFallback
                        ? `Computed from ${ratedCount} rostered agents' reviews`
                        : undefined
                    }
                    label="Avg Rating"
                    value={
                      displayRating > 0 ? (
                        <span className="flex items-center justify-center gap-0.5">
                          <Star className="h-4 w-4 text-amber-400 fill-amber-400" />
                          {Number(displayRating).toFixed(1)}
                        </span>
                      ) : (
                        "—"
                      )
                    }
                    sub={
                      agency.total_reviews > 0
                        ? `${agency.total_reviews} reviews`
                        : undefined
                    }
                  />
                );
              })()}
            </div>
          </section>

          {/* ── Active Suburbs — #25: concentration ranking ──
              Prefer listing-based ranking. Falls back to the flat
              suburbs_active chip cloud when no listings are loaded. */}
          {(suburbRanking.length > 0 || suburbs.length > 0) && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">
                  {suburbRanking.length > 0 ? "Suburb Concentration" : "Active Suburbs"}
                </h3>
                {suburbRanking.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAllSuburbs((p) => !p)}
                    className="text-[10px] text-primary hover:underline"
                  >
                    {showAllSuburbs ? "Show top 5" : `Show all ${suburbRanking.length}`}
                  </button>
                )}
              </div>
              {suburbRanking.length > 0 ? (
                <div className="space-y-1">
                  {(showAllSuburbs ? suburbRanking : suburbRanking.slice(0, 5)).map((s) => {
                    const max = suburbRanking[0]?.count || 1;
                    const pct = Math.round((s.count / max) * 100);
                    return (
                      <div key={s.suburb} className="space-y-0.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium truncate">{s.suburb}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {s.count} listing{s.count !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-400 dark:bg-blue-500 rounded-full transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {suburbs.map((sub, i) => (
                    <Badge
                      key={i}
                      variant="secondary"
                      className="text-[10px] py-0.5 px-2 bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800"
                    >
                      {sub}
                    </Badge>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ── Agent Roster ── */}
          <section>
            <div
              className="flex items-center justify-between gap-2 mb-2 rounded px-1 py-0.5"
              style={
                // #31: roster header bg tinted with 4% alpha of brand color
                brandAccent
                  ? { backgroundColor: hexToRgba(agency.brand_color_primary, 0.04) }
                  : undefined
              }
            >
              <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" />
                Agent Roster
                {roster.length > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[8px] py-0 px-1 ml-1 tabular-nums"
                  >
                    {roster.length}
                  </Badge>
                )}
              </h3>
              <div className="flex items-center gap-2">
                {/* AG05: sort options */}
                {roster.length > 1 && (
                  <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="uppercase tracking-wide">Sort</span>
                    <select
                      value={rosterSort}
                      onChange={(e) => setRosterSort(e.target.value)}
                      className="h-6 text-[10px] rounded border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Sort roster by"
                    >
                      {ROSTER_SORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {/* #29: Export roster CSV */}
                {roster.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px] gap-1"
                    onClick={handleExportRoster}
                    title="Export roster as CSV (UTF-8 with BOM)"
                  >
                    <Download className="h-3 w-3" />
                    Export roster
                  </Button>
                )}
              </div>
            </div>
            {/* #28: bulk add action bar — visible when ≥1 uncrm'd selected */}
            {selectedAgentIds.size > 0 && (
              <div className="flex items-center justify-between gap-2 mb-2 p-2 rounded-lg border border-primary/30 bg-primary/5">
                <span className="text-xs">
                  <strong className="tabular-nums">{selectedAgentIds.size}</strong>{" "}
                  agent{selectedAgentIds.size > 1 ? "s" : ""} selected
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setSelectedAgentIds(new Set())}
                    disabled={bulkAddingToCrm}
                  >
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[10px] gap-1"
                    onClick={handleBulkAddAgentsToCrm}
                    disabled={bulkAddingToCrm}
                  >
                    {bulkAddingToCrm ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <UserPlus className="h-3 w-3" />
                    )}
                    Add {selectedAgentIds.size} to CRM
                  </Button>
                </div>
              </div>
            )}
            {roster.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No agents found.</p>
            ) : (
              <div className="space-y-0.5">
                {roster.map((agent) => (
                  <React.Fragment key={agent.id}>
                    <AgentRow
                      agent={agent}
                      isInCrm={agent.is_in_crm}
                      isSelected={selectedAgent?.id === agent.id}
                      // #23: always drill through on click. onOpenEntity is
                      // provided by the panel-level drill stack; fallback
                      // shows the inline mini-profile (legacy behavior).
                      onSelect={
                        onOpenEntity
                          ? (a) => a && onOpenEntity({ type: "agent", id: a.id })
                          : setSelectedAgent
                      }
                      crmEntityId={agent.is_in_crm ? getCrmEntityIdForAgent(agent) : null}
                      // #28: checkbox only offered for uncrm'd agents
                      selectable={!agent.is_in_crm}
                      checked={selectedAgentIds.has(agent.id)}
                      onToggleChecked={toggleAgentSelection}
                    />
                    {!onOpenEntity && selectedAgent?.id === agent.id && (
                      <AgentMiniProfile
                        agent={agent}
                        onClose={() => setSelectedAgent(null)}
                      />
                    )}
                  </React.Fragment>
                ))}
              </div>
            )}
          </section>

          {/* ── Listings ── */}
          {(forSale.length > 0 || forRent.length > 0 || sold.length > 0) && (
            <section>
              <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2 flex items-center gap-1.5">
                <Home className="h-3.5 w-3.5" />
                Listings
                <Badge
                  variant="outline"
                  className="text-[8px] py-0 px-1 ml-1 tabular-nums"
                >
                  {agencyListings.length}
                </Badge>
              </h3>
              <div className="space-y-3">
                {forSale.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 mb-1">
                      For Sale ({forSale.length})
                    </p>
                    <div className="space-y-0.5">
                      {forSale.map((l) => (
                        <ListingRow
                          key={l.id}
                          l={l}
                          onOpen={onOpenEntity ? (lst) => onOpenEntity({ type: "listing", id: lst.id }) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {forRent.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-purple-600 dark:text-purple-400 mb-1">
                      For Rent ({forRent.length})
                    </p>
                    <div className="space-y-0.5">
                      {forRent.map((l) => (
                        <ListingRow
                          key={l.id}
                          l={l}
                          onOpen={onOpenEntity ? (lst) => onOpenEntity({ type: "listing", id: lst.id }) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {sold.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-blue-600 dark:text-blue-400 mb-1">
                      Sold ({sold.length})
                    </p>
                    <div className="space-y-0.5">
                      {sold.map((l) => (
                        <ListingRow
                          key={l.id}
                          l={l}
                          onOpen={onOpenEntity ? (lst) => onOpenEntity({ type: "listing", id: lst.id }) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {/* #24: deep-link to the Listings tab filtered to this agency. */}
              {agency.rea_agency_id && agencyListings.length > 0 && (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleViewAllListings}
                    className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline font-medium"
                    title="Open the Listings tab filtered to this agency"
                  >
                    View all {agencyListings.length} listings
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </section>
          )}

          {/* ── Sales by Property Type (AG06) ──
              pulse_agencies has no sales_breakdown column, so we aggregate
              per-agent sales_breakdown jsonb across the roster. Chart mirrors
              the agent dossier in PulseIntelligencePanel. */}
          {rosterSalesBreakdown && Object.keys(rosterSalesBreakdown).length > 0 && (
            <section>
              <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2 flex items-center gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" />
                Sales by Property Type
                <span className="text-[9px] font-normal normal-case text-muted-foreground/70 ml-1">
                  rolled up from roster
                </span>
              </h3>
              <div className="space-y-1.5">
                {Object.entries(rosterSalesBreakdown).map(([type, data]) => {
                  const maxCount = Math.max(
                    ...Object.values(rosterSalesBreakdown).map((d) => d.count || 0),
                    1
                  );
                  const pct = Math.round(((data.count || 0) / maxCount) * 100);
                  return (
                    <div key={type} className="space-y-0.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="capitalize font-medium">{type}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {data.count} sold
                          {data.medianSoldPrice ? ` \u00B7 ${fmtPrice(data.medianSoldPrice)} median` : ""}
                          {data.medianDaysOnSite ? ` \u00B7 ${data.medianDaysOnSite}d DOM` : ""}
                        </span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-red-400 dark:bg-red-500 rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Timeline ── */}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Timeline
            </h4>
            <PulseTimeline
              entries={slideoutTimeline}
              maxHeight="max-h-[300px]"
              emptyMessage="No timeline events for this agency"
              compact
            />
          </div>

          {/* ── Enrichment Metadata (collapsed) ── */}
          <section>
            <button
              onClick={() => setMetaOpen((p) => !p)}
              className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground/60 hover:text-muted-foreground transition-colors w-full"
            >
              {metaOpen ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Enrichment Metadata
            </button>
            {metaOpen && (
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-medium uppercase">Source</span>
                  <REABadge />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-medium uppercase">Synced</span>
                  <span>{fmtDate(agency.last_synced_at || agency.updated_at)}</span>
                </div>
                {agency.rea_agency_id && (
                  <div className="col-span-2 flex items-center gap-1.5">
                    <Hash className="h-3 w-3 shrink-0" />
                    <span className="font-mono text-[10px] break-all">
                      {agency.rea_agency_id}
                    </span>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* ── Footer with Add to CRM ── */}
        <div className="sticky bottom-0 bg-background border-t border-border px-5 py-3 flex items-center justify-between gap-3">
          {!isInCrm && !existingCrmAgency && (
            <Button
              size="sm"
              onClick={handleAddAgencyToCrm}
              disabled={addingToCrm}
              className="gap-1.5"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {addingToCrm ? "Adding..." : "Add to CRM"}
            </Button>
          )}
          {(isInCrm || existingCrmAgency) && (
            <span className="text-xs text-muted-foreground">Already in CRM</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* Tier 4: sync-run history for this agency */}
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setSyncHistoryOpen(true)}
              title="See which sync runs touched this agency"
            >
              <History className="h-3.5 w-3.5" />
              Source history
            </Button>
            {agency.rea_profile_url && (
              <a
                href={agency.rea_profile_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ExternalLink className="h-3.5 w-3.5" />
                  View REA Profile
                </Button>
              </a>
            )}
          </div>
        </div>
      </DialogContent>
      {syncHistoryOpen && (
        <EntitySyncHistoryDialog
          entityType="agency"
          entityId={agency.id}
          entityLabel={agency.name}
          onClose={() => setSyncHistoryOpen(false)}
        />
      )}
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ═══ MAIN COMPONENT ════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════ */

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

// UI sort-col → DB column. `live_agent_count` is a client-enrichment over
// `agent_count` that includes only "live" agents; PostgREST can only sort
// on real columns so we sort by `agent_count` as the closest equivalent.
const AGENCY_SERVER_SORT_MAP = {
  live_agent_count: "agent_count",
  agent_count: "agent_count",
  active_listings: "active_listings",
  total_sold_12m: "total_sold_12m",
  avg_sold_price: "avg_sold_price",
  avg_agent_rating: "avg_agent_rating",
  name: "name",
  suburb: "suburb",
  phone: "phone",
  email: "email",
};

const CSV_EXPORT_CAP_AGENCIES = 10000;

// localStorage — page-size choice + auto-refresh toggle persist per-tab.
const LS_PAGE_SIZE_KEY = "pulse_agencies_page_size";
const LS_AUTO_REFRESH_KEY = "pulse_agencies_auto_refresh";
const AUTO_REFRESH_INTERVAL_MS = 60_000;

function readStoredPageSize() {
  if (typeof window === "undefined") return 50;
  const raw = Number(window.localStorage.getItem(LS_PAGE_SIZE_KEY));
  return PAGE_SIZE_OPTIONS.includes(raw) ? raw : 50;
}
function readStoredAutoRefresh() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LS_AUTO_REFRESH_KEY) === "1";
}

export default function PulseAgencyIntel({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  pulseTimeline = [],
  crmAgents = [],
  crmAgencies = [],
  pulseMappings = [],
  targetSuburbs = [],
  search = "",
  stats = {},
  onOpenEntity,
}) {
  /* ── URL-driven deep-link seed (Φ2 HIGH) ──────────────────────────────
     Command Center's "Money on the table" banner links here with
     `?tab=agencies&in_crm=false&sort=listings.desc`. We seed initial state
     from those params on first mount, then strip them from the URL so a
     refresh / back-nav doesn't re-apply them on top of user edits. */
  const [searchParams, setSearchParams] = useSearchParams();
  // Read-once snapshot on mount (not reactive — we consume + strip below).
  const initialUrlFilter = (() => {
    const v = searchParams.get("in_crm");
    if (v === "true") return "in_crm";
    if (v === "false") return "not_in_crm";
    return null;
  })();
  const initialUrlSort = (() => {
    const raw = searchParams.get("sort");
    if (!raw) return null;
    // Accepts `${col}.${dir}`. We map the banner's virtual `listings` key
    // onto the real sort column (`active_listings`) so the table's server
    // sort-builder picks it up unchanged.
    const [rawCol, rawDir] = raw.split(".");
    if (!rawCol) return null;
    const COL_ALIAS = {
      listings: "active_listings",
      sold: "total_sold_12m",
      price: "avg_sold_price",
      rating: "avg_agent_rating",
      agents: "live_agent_count",
    };
    const col = COL_ALIAS[rawCol] || rawCol;
    const dir = rawDir === "asc" ? "asc" : "desc";
    if (!AGENCY_SERVER_SORT_MAP[col]) return null;
    return { col, dir };
  })();

  /* ── Local state ─────────────────────────────────────────────────────── */
  const [agencyFilter, setAgencyFilter] = useState(initialUrlFilter || "all"); // all | not_in_crm | in_crm
  const [agencySort, setAgencySort] = useState(
    initialUrlSort || { col: "live_agent_count", dir: "desc" },
  );
  const [agencyColFilter, setAgencyColFilter] = useState(""); // suburb text filter
  // Region filter (Auditor-11 F1) — "all" or a region name from pulse_target_suburbs.
  const [regionFilter, setRegionFilter] = useState("all");
  const [agencyPage, setAgencyPage] = useState(0);
  // Page size persists in localStorage so user choice survives reloads.
  const [pageSize, setPageSize] = useState(readStoredPageSize);
  const [selectedAgency, setSelectedAgency] = useState(null);
  // Auto-refresh — opt-in 60s. Agency data changes slowly.
  const [autoRefresh, setAutoRefresh] = useState(readStoredAutoRefresh);

  /* Consume the deep-link params once so they don't re-seed on re-render.
     Fires exactly once on mount; after that the user owns the filter/sort
     state and the URL is clean (only `?tab=agencies` remains). */
  useEffect(() => {
    if (!initialUrlFilter && !initialUrlSort) return;
    setSearchParams(
      (prev) => {
        const np = new URLSearchParams(prev);
        np.delete("in_crm");
        np.delete("sort");
        return np;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(LS_PAGE_SIZE_KEY, String(pageSize)); } catch { /* quota / SSR */ }
  }, [pageSize]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_AUTO_REFRESH_KEY, autoRefresh ? "1" : "0"); } catch { /* quota / SSR */ }
  }, [autoRefresh]);

  /* ── Build agent count map keyed by rea_agency_id or normalised name ──── */
  const agentCountMap = useMemo(() => {
    const m = {};
    for (const a of pulseAgents) {
      const key = a.agency_rea_id || normAgencyKey(a.agency_name);
      if (!key) continue;
      m[key] = (m[key] || 0) + 1;
    }
    return m;
  }, [pulseAgents]);

  /* ── Region filter derivations (Auditor-11 F1) ──────────────────────── */
  const regions = useMemo(() => {
    const set = new Set();
    for (const s of targetSuburbs || []) {
      if (s?.region) set.add(s.region);
    }
    return Array.from(set).sort();
  }, [targetSuburbs]);
  const suburbsInRegion = useMemo(() => {
    if (regionFilter === "all") return null;
    return (targetSuburbs || [])
      .filter((s) => s?.region === regionFilter && s?.name)
      .map((s) => s.name);
  }, [targetSuburbs, regionFilter]);

  /* ── Reset page on any filter/sort change (server-pagination refactor) ── */
  useEffect(() => {
    setAgencyPage(0);
  }, [agencyFilter, agencyColFilter, regionFilter, search, agencySort.col, agencySort.dir, pageSize]);

  /* ── Server-side query builder ──────────────────────────────────────── */
  const buildQuery = useCallback((selectCols, withCount) => {
    let q = api._supabase
      .from("pulse_agencies")
      .select(selectCols, withCount ? { count: "exact" } : undefined);

    if (agencyFilter === "in_crm") q = q.eq("is_in_crm", true);
    else if (agencyFilter === "not_in_crm") q = q.eq("is_in_crm", false);

    const sc = (agencyColFilter || "").trim();
    if (sc) {
      q = q.ilike("suburb", `%${sc.replace(/[%_]/g, "\\$&")}%`);
    }

    // Region filter (Auditor-11 F1) — expands to `suburb IN (...)`.
    if (suburbsInRegion) {
      if (suburbsInRegion.length === 0) {
        q = q.eq("id", "00000000-0000-0000-0000-000000000000");
      } else {
        q = q.in("suburb", suburbsInRegion);
      }
    }

    // B14: global search now uses the trigger-maintained `search_text` column
    // (primary + all alternates concatenated, lowercased) backed by a GIN
    // trigram index. One ilike substring match replaces the OR + JSONB
    // containment chain and covers alternates automatically.
    const globalQ = (search || "").trim();
    if (globalQ) {
      const s = globalQ.toLowerCase().replace(/[%_]/g, "\\$&");
      q = q.ilike("search_text", `%${s}%`);
    }

    const sortCol = AGENCY_SERVER_SORT_MAP[agencySort.col] || "agent_count";
    q = q.order(sortCol, { ascending: agencySort.dir === "asc", nullsFirst: false });

    return q;
  }, [agencyFilter, agencyColFilter, search, agencySort, suburbsInRegion]);

  /* ── Page fetch ─────────────────────────────────────────────────────── */
  const queryKey = useMemo(
    () => ["pulse-agencies-page", {
      agencyFilter, agencyColFilter, regionFilter, search,
      sortCol: agencySort.col, sortDir: agencySort.dir,
      page: agencyPage, pageSize,
    }],
    [agencyFilter, agencyColFilter, regionFilter, search, agencySort, agencyPage, pageSize],
  );

  const { data: pageData, isLoading, isFetching } = useQuery({
    queryKey,
    queryFn: async () => {
      const from = agencyPage * pageSize;
      const to = from + pageSize - 1;
      const q = buildQuery("*", true).range(from, to);
      const { data: rows, count, error } = await q;
      if (error) throw error;
      return { rows: rows || [], count: count || 0 };
    },
    keepPreviousData: true,
    staleTime: 30_000,
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  /* ── Enrich ONLY the fetched page with live_agent_count ─────────────── */
  const pageRows = useMemo(() => {
    const rows = pageData?.rows || [];
    return rows.map((ag) => ({
      ...ag,
      live_agent_count:
        agentCountMap[ag.rea_agency_id || normAgencyKey(ag.name)] ||
        ag.agent_count ||
        0,
    }));
  }, [pageData, agentCountMap]);

  /* #27: duplicate index — groups by normalised name across loaded agencies.
     Covers the current page + pulseAgencies prop for cross-page coverage. */
  const duplicateIndex = useMemo(() => {
    const map = new Map();
    const collect = (rows) => {
      for (const ag of rows || []) {
        const key = normAgencyNameForDupe(ag?.name);
        if (!key) continue;
        if (!map.has(key)) map.set(key, []);
        const list = map.get(key);
        if (!list.some((x) => x.id === ag.id)) {
          list.push({ id: ag.id, rea_agency_id: ag.rea_agency_id, name: ag.name });
        }
      }
    };
    collect(pulseAgencies);
    collect(pageRows);
    for (const [k, v] of map) if (v.length < 2) map.delete(k);
    return map;
  }, [pulseAgencies, pageRows]);

  useEffect(() => {
    if (duplicateIndex.size > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[PulseAgencyIntel #27] Duplicate agencies detected: ${duplicateIndex.size} group${duplicateIndex.size > 1 ? "s" : ""}`,
        Array.from(duplicateIndex.values())
      );
    }
  }, [duplicateIndex]);

  const totalCount = pageData?.count || 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(agencyPage, pageCount - 1);

  // For the "X of Y" display in the filter bar, show server total.
  const sorted = { length: totalCount }; // kept as object for minimal downstream churn

  const [exporting, setExporting] = useState(false);

  /* ── CSV export — fetch entire filtered set from server ──────────────── */
  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const cap = Math.min(totalCount, CSV_EXPORT_CAP_AGENCIES);
      if (totalCount > CSV_EXPORT_CAP_AGENCIES) {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
          `Filter matches ${totalCount.toLocaleString()} agencies. Only the first ${CSV_EXPORT_CAP_AGENCIES.toLocaleString()} will export. Continue?`,
        );
        if (!ok) { setExporting(false); return; }
      }
      const all = [];
      for (let off = 0; off < cap; off += 1000) {
        const end = Math.min(off + 999, cap - 1);
        const { data: chunk, error } = await buildQuery("*", false).range(off, end);
        if (error) throw error;
        all.push(...(chunk || []));
        if (!chunk || chunk.length < 1000) break;
      }
      // Enrich with live_agent_count before serialising
      const enriched = all.map((ag) => ({
        ...ag,
        live_agent_count:
          agentCountMap[ag.rea_agency_id || normAgencyKey(ag.name)] ||
          ag.agent_count ||
          0,
      }));
      const header = [
        "name", "suburb", "state", "phone", "email", "website",
        "live_agent_count", "active_listings", "total_sold_12m",
        "avg_sold_price", "avg_agent_rating", "is_in_crm",
        "rea_agency_id", "last_synced_at",
      ];
      exportCsv(`pulse_agencies_${new Date().toISOString().slice(0, 10)}.csv`, header, enriched);
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`CSV export failed: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  }, [buildQuery, totalCount, agentCountMap]);

  /* ── Sort toggle ──────────────────────────────────────────────────────── */
  function toggleSort(col) {
    setAgencySort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: "desc" }
    );
    setAgencyPage(0);
  }

  /* ── Filter change resets to page 0 ─────────────────────────────────── */
  function handleFilter(val) {
    setAgencyFilter(val);
    setAgencyPage(0);
  }

  function handleColFilter(val) {
    setAgencyColFilter(val);
    setAgencyPage(0);
  }

  /* ── Column header button ─────────────────────────────────────────────── */
  const ColHeader = ({ col, children, className }) => (
    <button
      onClick={() => toggleSort(col)}
      className={cn(
        "flex items-center gap-0.5 text-left font-medium text-muted-foreground hover:text-foreground transition-colors",
        agencySort.col === col && "text-foreground",
        className
      )}
    >
      {children}
      <SortIcon col={col} current={agencySort.col} dir={agencySort.dir} />
    </button>
  );

  /* ── Render ───────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-3">
      {/* ── Filter bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* CRM status filter */}
        <div className="flex items-center gap-1">
          {[
            { value: "all", label: "All Agencies" },
            { value: "not_in_crm", label: "Not in CRM" },
            { value: "in_crm", label: "In CRM" },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => handleFilter(value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
                agencyFilter === value
                  ? "bg-primary text-primary-foreground border-primary shadow-sm"
                  : "bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground"
              )}
            >
              {label}
              {value === "all"        && ` (${(stats?.totalAgencies ?? 0).toLocaleString()})`}
              {value === "not_in_crm" && ` (${(stats?.agenciesNotInCrm ?? 0).toLocaleString()})`}
              {value === "in_crm"     && ` (${(stats?.agenciesInCrm ?? 0).toLocaleString()})`}
            </button>
          ))}
        </div>

        {/* Region filter (Auditor-11 F1) */}
        {regions.length > 0 && (
          <select
            value={regionFilter}
            onChange={(e) => { setRegionFilter(e.target.value); setAgencyPage(0); }}
            className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
            title="Filter by region — expands to all suburbs in that region"
          >
            <option value="all">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        )}

        {/* Suburb column filter */}
        <div className="relative flex-1 max-w-xs">
          <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Filter by suburb…"
            value={agencyColFilter}
            onChange={(e) => handleColFilter(e.target.value)}
            className="w-full pl-7 pr-3 h-7 text-xs rounded-md border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {agencyColFilter && (
            <button
              onClick={() => handleColFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* CSV export + count + auto-refresh */}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={handleExportCsv}
            disabled={totalCount === 0 || exporting}
            title="Export filtered agencies as CSV (server-side, up to 10k rows)"
          >
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            CSV
          </Button>
          {/* Auto-refresh toggle — opt-in 60s. */}
          <label
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
            title="Auto-refresh every 60s"
          >
            <Switch
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
              aria-label="Auto-refresh every 60s"
            />
            <span>Auto-refresh</span>
          </label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {isFetching ? (
              <Loader2 className="inline h-3 w-3 animate-spin" />
            ) : totalCount === 0 ? (
              <>0 agencies</>
            ) : (
              <>
                {Math.min(agencyPage * pageSize + 1, totalCount).toLocaleString()}–{Math.min((agencyPage + 1) * pageSize, totalCount).toLocaleString()} of {totalCount.toLocaleString()}
              </>
            )}
          </span>
        </div>
      </div>

      {/* ── Table card ── */}
      <Card className="rounded-xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/30">
                {/* Logo */}
                <th className="pl-3 pr-2 py-2 w-10" />
                {/* Name */}
                <th className="px-2 py-2 text-left">
                  <ColHeader col="name">Agency</ColHeader>
                </th>
                {/* Phone */}
                <th className="px-2 py-2 text-left hidden md:table-cell">
                  <ColHeader col="phone">Phone</ColHeader>
                </th>
                {/* Email (NEW migration 108+) */}
                <th className="px-2 py-2 text-left hidden lg:table-cell">
                  <ColHeader col="email">Email</ColHeader>
                </th>
                {/* Agents */}
                <th className="px-2 py-2 text-right">
                  <ColHeader col="live_agent_count" className="ml-auto">
                    Agents
                  </ColHeader>
                </th>
                {/* Active Listings */}
                <th className="px-2 py-2 text-right hidden sm:table-cell">
                  <ColHeader col="active_listings" className="ml-auto">
                    Active
                  </ColHeader>
                </th>
                {/* Total Sold */}
                <th className="px-2 py-2 text-right hidden lg:table-cell">
                  <ColHeader col="total_sold_12m" className="ml-auto">
                    Sold 12m
                  </ColHeader>
                </th>
                {/* Avg Price */}
                <th className="px-2 py-2 text-right hidden lg:table-cell">
                  <ColHeader col="avg_sold_price" className="ml-auto">
                    Avg $
                  </ColHeader>
                </th>
                {/* Rating */}
                <th className="px-2 py-2 text-right hidden xl:table-cell">
                  <ColHeader col="avg_agent_rating" className="ml-auto">
                    Rating
                  </ColHeader>
                </th>
                {/* Last synced */}
                <th className="px-2 py-2 text-right hidden xl:table-cell">
                  <span className="text-muted-foreground font-medium">Synced</span>
                </th>
                {/* CRM */}
                <th className="px-2 py-2 text-right pr-3">
                  <span className="text-muted-foreground font-medium">CRM</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className="text-center py-12 text-muted-foreground"
                  >
                    <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground/40 animate-spin" />
                    <p className="text-sm">Loading agencies…</p>
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className="text-center py-12 text-muted-foreground"
                  >
                    <Building2 className="h-8 w-8 mx-auto mb-2 text-muted-foreground/20" />
                    <p className="text-sm">No agencies match your filters.</p>
                  </td>
                </tr>
              ) : (
                pageRows.map((ag, idx) => {
                  // B3: keyboard activation — wrap the click handler so Enter
                  // and Space on a focused row match the mouse behaviour.
                  const handleRowClick = () => {
                    if (onOpenEntity) {
                      onOpenEntity({ type: "agency", id: ag.id });
                    } else {
                      setSelectedAgency(ag);
                    }
                  };
                  return (
                  <tr
                    key={ag.id || idx}
                    onClick={handleRowClick}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleRowClick();
                      }
                    }}
                    aria-label={`Open ${ag.name || "agency"} details`}
                    className="border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors"
                  >
                    {/* Logo — #32: rounded-full everywhere */}
                    <td className="pl-3 pr-2 py-2 w-10">
                      <div className="h-8 w-8 rounded-full overflow-hidden bg-muted flex items-center justify-center border">
                        {ag.logo_url ? (
                          <img
                            src={ag.logo_url}
                            alt={ag.name}
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              e.target.style.display = "none";
                            }}
                          />
                        ) : (
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground/40" />
                        )}
                      </div>
                    </td>
                    {/* Name + suburb + optional brand color dot (migration 108+) */}
                    <td className="px-2 py-2 max-w-[180px]">
                      <div className="flex items-center gap-1.5">
                        {ag.brand_color_primary && (
                          <span
                            className="h-2.5 w-2.5 rounded-full border border-border shrink-0"
                            style={{ backgroundColor: ag.brand_color_primary }}
                            title={`Brand: ${ag.brand_color_primary}`}
                          />
                        )}
                        <p className="font-medium truncate">{ag.name || "—"}</p>
                      </div>
                      {ag.suburb && (
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                          <MapPin className="h-2.5 w-2.5 inline mr-0.5 -mt-px" />
                          {ag.suburb}
                          {ag.state && `, ${ag.state}`}
                        </p>
                      )}
                      {/* #27 / B2: duplicate warning chip — clickable popover
                          listing each sibling agency with a jump-to button. */}
                      {(() => {
                        const key = normAgencyNameForDupe(ag.name);
                        const grp = key ? duplicateIndex.get(key) : null;
                        if (!grp || grp.length < 2) return null;
                        const others = grp.filter((g) => g.id !== ag.id);
                        if (others.length === 0) return null;
                        return (
                          <Popover>
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 text-[9px] mt-1 px-1.5 py-0 rounded border border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-950/40 transition-colors cursor-pointer"
                                title={`${others.length} possible duplicate${others.length === 1 ? "" : "s"} — click to view`}
                              >
                                <AlertTriangle className="h-2.5 w-2.5" />
                                Possible duplicate
                                {others.length > 1 ? ` (+${others.length - 1})` : ""}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              className="w-64 p-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1 px-1">
                                Possible duplicates
                              </div>
                              <ul className="space-y-0.5">
                                {others.map((o) => (
                                  <li key={o.id}>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (onOpenEntity) {
                                          onOpenEntity({ type: "agency", id: o.id });
                                        } else {
                                          // Fallback: open the local slideout by
                                          // constructing a minimal agency stub —
                                          // full data refetches inside the slideout.
                                          setSelectedAgency({ id: o.id, name: o.name, rea_agency_id: o.rea_agency_id });
                                        }
                                      }}
                                      className="w-full flex items-start gap-1.5 px-2 py-1.5 rounded text-left text-xs hover:bg-muted transition-colors"
                                    >
                                      <Building2 className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium">{o.name || "—"}</div>
                                        {o.rea_agency_id && (
                                          <div className="truncate text-[9px] font-mono text-muted-foreground">
                                            #{o.rea_agency_id}
                                          </div>
                                        )}
                                      </div>
                                      <ExternalLink className="h-2.5 w-2.5 mt-1 text-muted-foreground/60 shrink-0" />
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </PopoverContent>
                          </Popover>
                        );
                      })()}
                    </td>
                    {/* Phone + AG10: +N alternates badge for parity with email */}
                    <td className="px-2 py-2 hidden md:table-cell text-muted-foreground">
                      {ag.phone ? (
                        <div className="flex items-center gap-1">
                          <a
                            href={`tel:${ag.phone}`}
                            onClick={(e) => e.stopPropagation()}
                            className="hover:text-foreground transition-colors"
                          >
                            {ag.phone}
                          </a>
                          {(() => {
                            const alts = alternateContacts(ag, "phone");
                            return alts.length > 0 ? (
                              <span
                                className="inline-flex items-center text-[9px] font-semibold px-1 py-0 rounded bg-muted text-muted-foreground shrink-0"
                                title={`${alts.length} other phone${alts.length !== 1 ? "s" : ""} seen`}
                              >
                                +{alts.length}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/30">—</span>
                      )}
                    </td>
                    {/* Email (NEW migration 108+) + AG11: ContactProvBadges + alt count */}
                    <td className="px-2 py-2 hidden lg:table-cell">
                      {ag.email ? (
                        <div className="flex items-center gap-1">
                          <a
                            href={`mailto:${ag.email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-primary hover:underline truncate max-w-[160px] block"
                          >
                            {ag.email}
                          </a>
                          {(() => {
                            const info = primaryContact(ag, "email");
                            return info?.value ? <ContactProvBadges info={info} /> : null;
                          })()}
                          {(() => {
                            const alts = alternateContacts(ag, "email");
                            return alts.length > 0 ? (
                              <span
                                className="inline-flex items-center text-[9px] font-semibold px-1 py-0 rounded bg-muted text-muted-foreground shrink-0"
                                title={`${alts.length} other email${alts.length !== 1 ? "s" : ""} seen`}
                              >
                                +{alts.length}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/30">—</span>
                      )}
                    </td>
                    {/* Agents */}
                    <td className="px-2 py-2 text-right tabular-nums">
                      <span
                        className={cn(
                          "font-semibold",
                          ag.live_agent_count > 0
                            ? "text-foreground"
                            : "text-muted-foreground/30"
                        )}
                      >
                        {ag.live_agent_count > 0 ? ag.live_agent_count : "—"}
                      </span>
                    </td>
                    {/* Active listings */}
                    <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">
                      <span
                        className={cn(
                          ag.active_listings > 0
                            ? "text-emerald-600 dark:text-emerald-400 font-medium"
                            : "text-muted-foreground/30"
                        )}
                      >
                        {ag.active_listings > 0 ? ag.active_listings : "—"}
                      </span>
                    </td>
                    {/* Total sold */}
                    <td className="px-2 py-2 text-right tabular-nums hidden lg:table-cell text-muted-foreground">
                      {ag.total_sold_12m > 0 ? ag.total_sold_12m : "—"}
                    </td>
                    {/* Avg price */}
                    <td className="px-2 py-2 text-right tabular-nums hidden lg:table-cell font-medium">
                      {fmtPrice(ag.avg_sold_price)}
                    </td>
                    {/* Rating — fallback to weighted roster mean when
                        avg_agent_rating is null (only ~9% populated). */}
                    <td className="px-2 py-2 text-right hidden xl:table-cell">
                      <span className="flex items-center justify-end gap-0.5">
                        <StarRating
                          value={
                            ag.avg_agent_rating ??
                            computeAgencyRating(rosterForAgency(ag, pulseAgents))
                          }
                        />
                      </span>
                    </td>
                    {/* Last synced */}
                    <td
                      className="px-2 py-2 text-right text-[10px] text-muted-foreground hidden xl:table-cell whitespace-nowrap"
                      title={ag.last_synced_at ? new Date(ag.last_synced_at).toLocaleString() : "Never synced"}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        <Clock className="h-2.5 w-2.5" />
                        {fmtAgo(ag.last_synced_at)}
                      </span>
                    </td>
                    {/* CRM badge */}
                    <td className="px-2 py-2 text-right pr-3">
                      <CrmBadge inCrm={!!ag.is_in_crm} />
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {sorted.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t bg-muted/20">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {safePage * pageSize + 1}–
                {Math.min((safePage + 1) * pageSize, sorted.length)} of{" "}
                {sorted.length.toLocaleString()}
              </span>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setAgencyPage(0); }}
                className="h-6 text-[10px] rounded border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring"
                title="Rows per page"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-6 w-6"
                disabled={safePage === 0}
                onClick={() => setAgencyPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <span className="text-[10px] text-muted-foreground tabular-nums px-1">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-6 w-6"
                disabled={safePage >= pageCount - 1}
                onClick={() => setAgencyPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Agency Slideout (fallback path — when onOpenEntity is missing) ──
          B1: forward onOpenEntity so nested drill (e.g. clicking an agent in
          the roster) still round-trips through the global entity stack. When
          the prop is missing the slideout silently falls back to its own
          internal nav, which doesn't sync to URL. */}
      {selectedAgency && (
        <AgencySlideout
          agency={selectedAgency}
          pulseAgents={pulseAgents}
          pulseListings={pulseListings}
          pulseTimeline={pulseTimeline}
          crmAgencies={crmAgencies}
          pulseMappings={pulseMappings}
          pulseAgencies={pulseAgencies}
          onOpenEntity={onOpenEntity}
          onClose={() => setSelectedAgency(null)}
        />
      )}
    </div>
  );
}

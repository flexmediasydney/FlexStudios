/**
 * PulseIntelligencePanel — REA-only Intelligence Dossier
 * Comprehensive view of everything the pulse engine knows about an agent or agency.
 *
 * Data sources: websift (agent profiles + stats), azzouzana (listings with agent emails/photos)
 * Single link ID: rea_agent_id connects agents -> listings -> agencies.
 *
 * Props:
 *   entityType: 'agent' | 'agency'
 *   entityId / crmEntityId: UUID of the CRM record
 *   entityName: CRM record display name (informational only)
 *   crmEntity: full CRM entity record (optional, used for rea_agent_id fallback)
 *   onOpenEntity: optional ({type, id}) => void — when the panel is rendered
 *     inside a slideout stack (IndustryPulse page), the parent passes its
 *     openEntity handler so timeline/roster clicks push onto the stack
 *     instead of full-navigating. Omitted from PersonDetails/OrgDetails so
 *     those surfaces fall back to navigate().
 */
import React, { useMemo, useState, useCallback, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useQuery } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import PulseTimeline from "@/components/pulse/PulseTimeline";
import { Star, MapPin, Building2, Phone, Mail, Globe, ExternalLink, Award,
  TrendingUp, Users, Home, Clock, AlertTriangle, CheckCircle2, DollarSign,
  Briefcase, Hash, Facebook, Instagram, Linkedin, ChevronDown, Shield,
  BarChart3, User, Loader2, BookOpen, Database, History, Sparkles, Palette,
  UserPlus, X, Copy, Check, Map as MapIcon, ChevronRight, Download,
  Filter, ArrowUp, ArrowDown
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import EntitySyncHistoryDialog from "@/components/pulse/EntitySyncHistoryDialog";
import SourceDrillDrawer from "@/components/pulse/timeline/SourceDrillDrawer";
import {
  displayPrice as sharedDisplayPrice,
  LISTING_TYPE_LABEL,
  listingTypeBadgeClasses,
  primaryContact,
  alternateContacts,
} from "@/components/pulse/utils/listingHelpers";

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function fmtPrice(v) {
  if (!v || v <= 0) return "\u2014";
  return v >= 1_000_000
    ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
      ? `$${Math.round(v / 1_000)}K`
      : `$${v}`;
}

function fmtDate(d) {
  if (!d) return "\u2014";
  try {
    return new Date(d).toLocaleDateString("en-AU", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return "\u2014"; }
}

function mapPosition(jobTitle) {
  const jt = (jobTitle || "").toLowerCase();
  if (
    jt.includes("principal") || jt.includes("director") || jt.includes("managing") ||
    jt.includes("licensee") || jt.includes("owner") || jt.includes("ceo") || jt.includes("partner")
  ) return "Partner";
  if (
    jt.includes("senior") || jt.includes("manager") || jt.includes("head of") || jt.includes("auctioneer")
  ) return "Senior";
  return jt.includes("associate") ? "Associate" : "Junior";
}

function positionColor(pos) {
  if (pos === "Partner") return "text-purple-600 border-purple-200";
  if (pos === "Senior") return "text-blue-600 border-blue-200";
  if (pos === "Associate") return "text-teal-600 border-teal-200";
  return "text-muted-foreground";
}

function integrityColor(score) {
  if (score > 70) return { text: "text-green-600", bg: "bg-green-500", border: "border-green-200", badge: "bg-green-50 dark:bg-green-950/20" };
  if (score >= 50) return { text: "text-amber-600", bg: "bg-amber-500", border: "border-amber-200", badge: "bg-amber-50 dark:bg-amber-950/20" };
  return { text: "text-red-600", bg: "bg-red-500", border: "border-red-200", badge: "bg-red-50 dark:bg-red-950/20" };
}

const normAddr = (s) =>
  (s || "").replace(/[,\s]+/g, " ").replace(/\b(nsw|vic|qld|sa|wa|tas|nt|act)\b/gi, "")
    .replace(/\d{4}/, "").replace(/australia/gi, "").trim().toLowerCase();

/**
 * Convert a hex color (#RRGGBB or #RGB) to an `rgba(...)` string. Returns null
 * when the input isn't parseable. Used for AG07 brand-color accents — a 3px
 * top-border + ~6% tinted background on agency cards when brand_color_primary
 * is populated (~7% of agencies).
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
 * Rank suburbs by listing count within an agency's active listings (#25).
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
 * Write rows to a CSV file with an optional UTF-8 BOM prefix (#29). The BOM
 * is important for Excel to autodetect the encoding on non-ASCII agent
 * names (O'Neill, accented chars).
 */
function exportCsvWithBom(filename, header, rows) {
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(","));
  const body = "\uFEFF" + lines.join("\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url;
  el.download = filename;
  document.body.appendChild(el);
  el.click();
  document.body.removeChild(el);
  URL.revokeObjectURL(url);
}

/**
 * Aggregate sales_breakdown across an agency's roster. pulse_agencies has
 * no sales_breakdown column, so the dossier computes this client-side from
 * the per-agent rows. Sums counts; weights median price / days-on-site by
 * count for a stable rollup.
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

/* Roster sort options (AG05) — photography pitch: "who's shooting a lot?" */
const ROSTER_SORT_OPTIONS = [
  { value: "active", label: "Active listings" },
  { value: "sold", label: "Sold (12m)" },
  { value: "rating", label: "Rating" },
  { value: "name", label: "Name" },
];
const ROSTER_SORT_DEFAULT = "active";

function sortRoster(list, sortKey, sortDir = "desc") {
  if (!Array.isArray(list)) return [];
  const arr = list.slice();
  // Numeric columns treat bigger-is-better as "desc" (default). "name" treats
  // A-Z as "asc".
  switch (sortKey) {
    case "sold":
      arr.sort((a, b) => (b.sales_as_lead || b.total_sold_12m || 0) - (a.sales_as_lead || a.total_sold_12m || 0));
      break;
    case "rating":
      arr.sort((a, b) => (b.rea_rating || b.reviews_avg || 0) - (a.rea_rating || a.reviews_avg || 0));
      break;
    case "position":
      // Partners first, then Senior, Associate, Junior. Falls back to name.
      {
        const rank = { Partner: 0, Senior: 1, Associate: 2, Junior: 3 };
        arr.sort((a, b) => {
          const ra = rank[mapPosition(a.job_title)] ?? 9;
          const rb = rank[mapPosition(b.job_title)] ?? 9;
          if (ra !== rb) return ra - rb;
          return (a.full_name || "").localeCompare(b.full_name || "");
        });
      }
      break;
    case "name":
      arr.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
      break;
    case "active":
    default:
      arr.sort((a, b) => (b.total_listings_active || 0) - (a.total_listings_active || 0));
      break;
  }
  if (sortDir === "asc") arr.reverse();
  return arr;
}

const normName = (s) =>
  (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

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
      <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="truncate">{address}</span>
      <button
        type="button"
        onClick={doCopy}
        title={copied ? "Copied!" : "Copy address"}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
      <a
        href={mapsHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Open in Google Maps"
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
      >
        <MapIcon className="h-3 w-3" />
      </a>
    </span>
  );
}

const parseJSON = (val, field = "<unknown>") => {
  if (!val) return null;
  try {
    return typeof val === "string" ? JSON.parse(val) : val;
  } catch (e) {
    // AG16: surface malformed data in dev so we notice bad payloads instead of
    // silently coalescing to null. Guarded to avoid prod console noise.
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[PulseIntelligencePanel] parseJSON failed for", field, "err=", e);
    }
    return null;
  }
};

const parseArray = (val, field = "<unknown>") => {
  const parsed = parseJSON(val, field);
  return Array.isArray(parsed) ? parsed : [];
};

const REABadge = () => (
  <span className="text-[7px] font-bold uppercase px-1 py-0 rounded ml-1 inline-block leading-relaxed bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
    REA
  </span>
);

/* ── Contact-provenance mini-badges + alternate disclosure ───────────────────── */

/**
 * Small row of badges that annotate a primary contact value: "verified" when
 * 2+ sources agree, "detail" when the source starts with `detail_page_`,
 * and "stale" when last_seen_at > 90d ago.
 *
 * Shown inline next to an email/phone/mobile value.
 */
function ContactProvBadges({ info }) {
  if (!info || !info.value) return null;
  const isDetail = typeof info.source === "string" && info.source.startsWith("detail_page_");
  return (
    <span className="inline-flex items-center gap-0.5 ml-1 align-middle">
      {info.verified && (
        <span
          title={`Verified across ${info.sourcesCount} sources`}
          className="inline-flex items-center gap-0.5 text-[8px] font-semibold uppercase px-1 py-0 rounded text-emerald-700 bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-800/40"
        >
          <CheckCircle2 className="h-2 w-2" /> verified
        </span>
      )}
      {isDetail && (
        <span
          title="Sourced from listing detail page"
          className="inline-flex items-center gap-0.5 text-[8px] font-semibold uppercase px-1 py-0 rounded text-indigo-700 bg-indigo-50 border border-indigo-200 dark:bg-indigo-950/20 dark:text-indigo-400 dark:border-indigo-800/40"
        >
          <Sparkles className="h-2 w-2" /> detail
        </span>
      )}
      {info.stale && (
        <span
          title="Last seen > 90 days ago"
          className="inline-flex items-center text-[8px] font-semibold uppercase px-1 py-0 rounded text-amber-700 bg-amber-50 border border-amber-200 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-800/40"
        >
          stale
        </span>
      )}
    </span>
  );
}

/**
 * Collapsible "Also seen" disclosure listing alternate values for a given
 * contact field with their sources, confidence, and first/last seen dates.
 *
 * Renders nothing when there are no alternates.
 */
function AlternateContactsDisclosure({ entity, field, labelPlural, icon: Icon = Mail }) {
  const [open, setOpen] = useState(false);
  const items = useMemo(() => alternateContacts(entity, field), [entity, field]);
  if (!items || items.length === 0) return null;

  const fmtShort = (d) => {
    if (!d) return "—";
    try {
      return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" });
    } catch { return "—"; }
  };

  const isEmail = field === "email";

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        Also seen: {items.length} other {labelPlural}
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-3 border-l border-border/60">
          {items.map((alt, i) => (
            <div key={`${alt.value}-${i}`} className="text-[10px] leading-snug">
              <div className="flex items-center gap-1">
                <Icon className="h-2.5 w-2.5 text-muted-foreground/50" />
                {isEmail ? (
                  <a href={`mailto:${alt.value}`} className="text-primary/80 hover:underline truncate">
                    {alt.value}
                  </a>
                ) : (
                  <a href={`tel:${alt.value}`} className="text-primary/80 hover:underline truncate">
                    {alt.value}
                  </a>
                )}
                {alt.confidence != null && (
                  <span className="text-[8px] text-muted-foreground/60 tabular-nums">
                    {alt.confidence}%
                  </span>
                )}
              </div>
              <div className="text-[9px] text-muted-foreground/70 pl-3.5 flex flex-wrap gap-x-2 gap-y-0.5">
                {alt.sources.length > 0 && (
                  <span>src: {alt.sources.join(", ")}</span>
                )}
                {alt.first_seen_at && <span>first {fmtShort(alt.first_seen_at)}</span>}
                {alt.last_seen_at && <span>last {fmtShort(alt.last_seen_at)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Section header ──────────────────────────────────────────────────────────── */

const SectionHeader = ({ icon: Icon, children, count }) => (
  <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1.5">
    {Icon && <Icon className="h-3.5 w-3.5" />}
    {children}
    {count != null && count > 0 && (
      <Badge variant="outline" className="text-[8px] py-0 px-1 ml-1 tabular-nums">{count}</Badge>
    )}
  </h3>
);

/* ── Stat box ────────────────────────────────────────────────────────────────── */

/* #31: StatBox now accepts an optional brand color for a 3px left border. */
const StatBox = ({ value, label, brandColor, title }) => (
  <div
    className="bg-muted/40 rounded-lg p-2.5 text-center"
    style={brandColor ? { borderLeft: `3px solid ${brandColor}` } : undefined}
    title={title}
  >
    <p className="text-lg font-bold">{value}</p>
    <p className="text-[9px] text-muted-foreground">{label}</p>
  </div>
);

/* ── Listing row (shared for sale/rent/sold) ─────────────────────────────────── */

const ListingRow = ({ l, showSoldInfo }) => {
  // Canonical price label (handles sold/rent/under_contract + /wk via suffix).
  const priceLabel = sharedDisplayPrice(l).label;
  const hasPrice = priceLabel && priceLabel !== "—" && priceLabel !== "\u2014";

  return (
    <a
      href={l.source_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors"
    >
      {l.image_url && (
        <img src={l.image_url} alt="" className="h-10 w-14 object-cover rounded shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{l.address || l.suburb || "\u2014"}</p>
        <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
          {l.suburb && <span>{l.suburb}</span>}
          {showSoldInfo ? (
            <>
              {hasPrice && <span className="font-medium text-foreground">{priceLabel}</span>}
              {l.sold_date && <span className="text-[9px]">Sold {fmtDate(l.sold_date)}</span>}
            </>
          ) : (
            <>
              {l.previous_asking_price && (
                <span className="text-muted-foreground line-through text-[10px] mr-1">
                  {fmtPrice(l.previous_asking_price)}
                </span>
              )}
              {hasPrice && <span className="font-medium text-foreground">{priceLabel}</span>}
              {l.bedrooms && <span>{l.bedrooms}bed</span>}
              {l.bathrooms && <span>{l.bathrooms}bath</span>}
              {l.first_seen_at && <span className="text-[9px]">Listed {fmtDate(l.first_seen_at)}</span>}
            </>
          )}
        </div>
      </div>
      {l.listing_type === "for_rent" && (
        <Badge variant="outline" className="text-[7px] py-0 text-purple-600 border-purple-200 shrink-0">Rent</Badge>
      )}
      {l.listing_type === "sold" && (
        <Badge className="text-[7px] bg-emerald-100 text-emerald-700 border-0 shrink-0">Sold</Badge>
      )}
      {l.listing_type === "under_contract" && (() => {
        // under_contract was missing from the badge set entirely — the listing
        // would render with NO badge. Use shared amber classes for consistency.
        const c = listingTypeBadgeClasses("under_contract");
        return (
          <Badge
            variant="outline"
            className={cn("text-[7px] py-0 shrink-0", c.text, c.border)}
          >
            {LISTING_TYPE_LABEL.under_contract}
          </Badge>
        );
      })()}
      {l.listing_type === "for_sale" && (
        <ExternalLink className="h-3 w-3 text-primary shrink-0" />
      )}
    </a>
  );
};

/* ── Inline copy-to-clipboard button used next to contact fields. ───────────
   Keeps the UI non-invasive (h-5 w-5 icon button) and gives a short toast +
   Check flash on success. Returns null for empty values so the surrounding
   layout collapses cleanly. */
function CopyInlineButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback((e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!value) return;
    try {
      navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label || "Copied"}!`);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Copy failed");
    }
  }, [value, label]);
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-muted"
      title={label || "Copy"}
      aria-label={label || "Copy"}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
    </button>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════ */
/* ═══ MAIN COMPONENT ═══════════════════════════════════════════════════════ */
/* ═════════════════════════════════════════════════════════════════════════════ */

export default function PulseIntelligencePanel({
  entityType,
  entityId: propEntityId,
  crmEntityId,
  entityName,
  crmEntity,
  onOpenEntity,
}) {
  // Accept both prop shapes (new: entityId, old: crmEntityId)
  const entityId = propEntityId || crmEntityId;
  const [metadataOpen, setMetadataOpen] = useState(false);
  // Tier 4: source-history drill
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
  // IP02: Add-to-CRM dialog state
  const [addToCrmOpen, setAddToCrmOpen] = useState(false);
  // IP03: confirm/reject in-flight state
  const [mappingActionBusy, setMappingActionBusy] = useState(false);
  // AG05: roster sort — default = Active listings
  const [rosterSort, setRosterSort] = useState(ROSTER_SORT_DEFAULT);
  // #25: toggle all suburbs
  const [showAllSuburbs, setShowAllSuburbs] = useState(false);
  // #28: bulk-select set of pulse_agent ids (uncrm'd only).
  const [selectedAgentIds, setSelectedAgentIds] = useState(() => new Set());
  const [bulkAddingToCrm, setBulkAddingToCrm] = useState(false);
  // Dossier tab state — controls which of the overview/listings sections is
  // visible (via `hidden={dossierTab !== X}` on the wrapping divs).
  // Default "overview" matches historical landing.
  const [dossierTab, setDossierTab] = useState("overview");
  // AG05/#75 — roster column sort direction (asc/desc). Paired with rosterSort.
  const [rosterSortDir, setRosterSortDir] = useState("desc");
  // #74 — clicking a property-type bar filters the Listings tab. null = unfiltered.
  const [breakdownTypeFilter, setBreakdownTypeFilter] = useState(null);
  // Flash-target section ring animation (used when jumping from another view).
  const [flashSection, setFlashSection] = useState(null);
  // In-place sync-log drill drawer — triggered from TimelineRow / Section 11 /
  // Section 12 when the panel is embedded in a slideout stack. Looks up the
  // sync_log by id to resolve (source_id, started_at) and feed SourceDrillDrawer.
  const [syncLogDrill, setSyncLogDrill] = useState(null);
  const navigate = useNavigate();

  // Tab change + optional flash-target section highlight. Wrapped in useCallback
  // so the clickable breakdown bars / nav buttons keep stable refs.
  const handleDossierTabChange = useCallback((tabValue, targetSection = null) => {
    setDossierTab(tabValue);
    if (targetSection) {
      setFlashSection(targetSection);
      setTimeout(() => setFlashSection(null), 1400);
    }
  }, []);

  // P0 #1: Timeline / roster / agency-name click handler — prefers the
  // parent-supplied onOpenEntity (so slideout stacks push a new level) and
  // falls back to navigate() when the panel is rendered outside a stack
  // (PersonDetails / OrgDetails).
  const handleTimelineOpenEntity = useCallback((entity) => {
    if (!entity?.type || !entity?.id) return;
    if (onOpenEntity) {
      onOpenEntity(entity);
      return;
    }
    const tabSlug = entity.type === "listing"
      ? "listings"
      : entity.type === "agency" ? "agencies" : "agents";
    navigate(`/IndustryPulse?tab=${tabSlug}&entity_type=${entity.type}&pulse_id=${encodeURIComponent(entity.id)}`);
  }, [onOpenEntity, navigate]);

  // P0 #2 / #3: Sync-log drill handler. When passed to TimelineRow /
  // Section 11 sync-run link, clicking the external-link icon opens the
  // SourceDrillDrawer in-place instead of collapsing the slideout stack.
  const handleOpenSyncLog = useCallback((syncLogId) => {
    if (!syncLogId) return;
    setSyncLogDrill({ syncLogId });
  }, []);

  // Roster column-header click: same column toggles direction, new column
  // resets to desc (higher-is-better default for numeric columns).
  const handleRosterSortClick = useCallback((key) => {
    if (rosterSort === key) {
      setRosterSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setRosterSort(key);
      setRosterSortDir("desc");
    }
  }, [rosterSort]);

  /* ── IP01: Single-RPC dossier fetch ──────────────────────────────────────
     Replaces the six useEntityList calls that were pulling >10k rows
     client-side just to render one dossier. See migration 123_dossier_rpc.sql.
     Feature flag `USE_DOSSIER_RPC` left true by default; flip to false
     (localStorage or env) to fall back to the legacy multi-query path if
     ever needed. */
  const USE_DOSSIER_RPC =
    typeof window === "undefined"
      ? true
      : (window.localStorage?.getItem("pulse.dossierRpc") ?? "1") !== "0";

  const {
    data: dossier,
    isLoading: dossierLoading,
    refetch: refetchDossier,
  } = useQuery({
    queryKey: ["pulse_dossier", entityType, entityId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("pulse_get_dossier", {
        p_entity_type: entityType,
        p_entity_id: entityId,
      });
      if (error) throw error;
      return data;
    },
    enabled: USE_DOSSIER_RPC && !!entityId && !!entityType,
    staleTime: 30_000,
  });

  /* ── Legacy multi-query fallback ───────────────────────────────────────── */
  // Only fetches when the feature flag is disabled. When the RPC path is on,
  // these hooks short-circuit (enabled: false in useEntityList would be ideal
  // but useEntityList has no such option; passing limit 0 avoids the network
  // cost while keeping the return shape stable).
  const legacyEnabled = !USE_DOSSIER_RPC;
  const {
    data: legacyMappings = [],
    loading: legacyMappingsLoading,
  } = useEntityList(legacyEnabled ? "PulseCrmMapping" : null, "-created_at");
  const {
    data: legacyAgents = [],
    loading: legacyAgentsLoading,
  } = useEntityList(legacyEnabled ? "PulseAgent" : null, "-last_synced_at", 5000);
  const {
    data: legacyAgencies = [],
    loading: legacyAgenciesLoading,
  } = useEntityList(legacyEnabled ? "PulseAgency" : null, "-last_synced_at", 500);
  const { data: legacyListings = [] } = useEntityList(
    legacyEnabled ? "PulseListing" : null, "-created_at", 5000
  );
  const { data: legacyTimeline = [] } = useEntityList(
    legacyEnabled ? "PulseTimeline" : null, "-created_at", 500
  );
  const { data: legacyProjects = [] } = useEntityList(
    legacyEnabled ? "Project" : null, "-shoot_date"
  );

  /* ── Derived values (RPC-first, legacy fallback) ───────────────────────── */
  const coreLoading = USE_DOSSIER_RPC
    ? dossierLoading
    : (legacyMappingsLoading || legacyAgentsLoading || legacyAgenciesLoading);

  // Mapping
  const mapping = useMemo(() => {
    if (USE_DOSSIER_RPC) return dossier?.mapping || null;
    return legacyMappings.find(
      m => m.crm_entity_id === entityId && m.entity_type === entityType
    ) || null;
  }, [USE_DOSSIER_RPC, dossier, legacyMappings, entityId, entityType]);

  // Pulse record (agent or agency row)
  const pulseData = useMemo(() => {
    if (USE_DOSSIER_RPC) return dossier?.pulse_record || null;

    const collection = entityType === "agent" ? legacyAgents : legacyAgencies;
    const idField = entityType === "agent" ? "rea_agent_id" : "rea_agency_id";

    if (mapping?.pulse_entity_id) {
      const match = collection.find(a => a.id === mapping.pulse_entity_id);
      if (match) return match;
    }
    if (mapping?.rea_id) {
      const match = collection.find(a => a[idField] === mapping.rea_id);
      if (match) return match;
    }
    if (crmEntity?.[idField]) {
      const match = collection.find(a => a[idField] === crmEntity[idField]);
      if (match) return match;
    }
    if (entityName && entityType === "agent") {
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z\s]/g, "").trim();
      const nameMatch = legacyAgents.find(a => norm(a.full_name) === norm(entityName));
      if (nameMatch) return nameMatch;
    }
    if (entityName && entityType === "agency") {
      const nameMatch = legacyAgencies.find(a => normName(a.name) === normName(entityName));
      if (nameMatch) return nameMatch;
    }
    return null;
  }, [USE_DOSSIER_RPC, dossier, entityType, mapping, legacyAgents, legacyAgencies, crmEntity, entityName]);

  // Timeline events (aggregated: agent events + their listings; agency events
  // + all agents + all listings). Migration 135 widened the RPC accordingly.
  const entityTimelineEntries = useMemo(() => {
    if (USE_DOSSIER_RPC) return dossier?.timeline || [];
    if (!entityId) return [];
    return legacyTimeline.filter(t => {
      if (t.crm_entity_id === entityId) return true;
      if (mapping?.rea_id && String(t.rea_id) === String(mapping.rea_id)) return true;
      if (mapping?.pulse_entity_id && t.pulse_entity_id === mapping.pulse_entity_id) return true;
      if (crmEntity?.rea_agent_id && String(t.rea_id) === String(crmEntity.rea_agent_id)) return true;
      if (crmEntity?.rea_agency_id && String(t.rea_id) === String(crmEntity.rea_agency_id)) return true;
      return false;
    });
  }, [USE_DOSSIER_RPC, dossier, legacyTimeline, entityId, mapping, crmEntity]);

  // Timeline source filter: 'all' | 'direct' | 'agent' | 'listing'
  const [timelineSourceFilter, setTimelineSourceFilter] = useState("all");

  // Counts per source bucket (derived from entries so it stays correct under
  // both RPC and legacy paths).
  const timelineSummary = useMemo(() => {
    const rows = entityTimelineEntries || [];
    const rpcSummary = dossier?.timeline_summary;
    // Prefer the RPC's breakdown (authoritative) but compute client-side as a
    // fallback for the legacy path.
    const byEntityType = rpcSummary?.by_entity_type || rows.reduce((acc, r) => {
      const k = r.entity_type || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return {
      total: rows.length,
      byEntityType,
    };
  }, [entityTimelineEntries, dossier]);

  const filteredTimelineEntries = useMemo(() => {
    const rows = entityTimelineEntries || [];
    if (timelineSourceFilter === "all") return rows;
    if (timelineSourceFilter === "direct") {
      // "Direct" = events on the entity itself (matches its own entity_type).
      return rows.filter(r => r.entity_type === entityType);
    }
    return rows.filter(r => r.entity_type === timelineSourceFilter);
  }, [entityTimelineEntries, timelineSourceFilter, entityType]);

  /* ── IP04: dedicated targeted listings fetch ──────────────────────────────
     The legacy path filters `legacyListings` in-memory — that list is capped
     at 5000 rows, so agents/agencies with tail activity beyond the cap were
     silently dropped. Under the RPC path the dossier RPC already returns
     listings; we still issue a standalone per-entity query so a top-agent
     dossier can pull up to 100 rows reliably even if the RPC slice is
     conservative. Fires once the entity's REA ID is known (from pulseData
     or crmEntity fallback). */
  const entityReaIdForListings = pulseData?.rea_agent_id
    || pulseData?.rea_agency_id
    || (entityType === "agent" ? crmEntity?.rea_agent_id : crmEntity?.rea_agency_id)
    || null;

  const {
    data: targetedListings,
    isError: targetedListingsError,
  } = useQuery({
    queryKey: ["entity-listings", entityType, entityReaIdForListings],
    queryFn: async () => {
      const col = entityType === "agent" ? "agent_rea_id" : "agency_rea_id";
      const { data, error } = await supabase
        .from("pulse_listings")
        .select("*")
        .eq(col, entityReaIdForListings)
        .order("listed_date", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
    enabled: !!entityReaIdForListings,
    staleTime: 30_000,
  });

  // Listings for this entity — prefer the dedicated targeted fetch so agents
  // with listings beyond the 5k legacy cap (or beyond the dossier RPC's
  // returned slice) still render completely. Falls back to RPC/legacy data
  // whenever the query errors or hasn't resolved yet.
  const entityListings = useMemo(() => {
    if (targetedListings && targetedListings.length > 0 && !targetedListingsError) {
      return targetedListings;
    }
    if (USE_DOSSIER_RPC) return dossier?.listings || [];
    if (!pulseData) return [];
    if (entityType === "agent") {
      const reaId = pulseData.rea_agent_id;
      if (reaId) return legacyListings.filter(l => l.agent_rea_id === reaId);
      return [];
    }
    const reaId = pulseData.rea_agency_id;
    if (reaId) {
      const byId = legacyListings.filter(l => l.agency_rea_id === reaId);
      if (byId.length > 0) return byId;
    }
    const name = normName(pulseData.name);
    if (name) return legacyListings.filter(l => normName(l.agency_name) === name);
    return [];
  }, [targetedListings, targetedListingsError, USE_DOSSIER_RPC, dossier, entityType, pulseData, legacyListings]);

  const activeListings = entityListings.filter(l => l.listing_type === "for_sale" || l.listing_type === "for_rent");
  const forSaleListings = entityListings.filter(l => l.listing_type === "for_sale");
  const forRentListings = entityListings.filter(l => l.listing_type === "for_rent");
  const soldListings = entityListings.filter(l => l.listing_type === "sold");

  // Cross-linked CRM projects
  const entityProjects = useMemo(() => {
    if (USE_DOSSIER_RPC) return dossier?.cross_linked_projects || [];
    if (entityType === "agent") {
      return legacyProjects.filter(p => p.agent_id === entityId || p.client_id === entityId);
    }
    return legacyProjects.filter(p => p.agency_id === entityId);
  }, [USE_DOSSIER_RPC, dossier, legacyProjects, entityId, entityType]);

  // Agency roster (agency entityType only) — RPC returns pulse_agents rows
  // with an attached `crm_mapping` field already joined server-side.
  // AG05: sort order is user-selectable (default = Active listings).
  const agencyAgents = useMemo(() => {
    let base = [];
    if (USE_DOSSIER_RPC) base = dossier?.agency_roster || [];
    else if (entityType !== "agency" || !pulseData) base = [];
    else if (pulseData.rea_agency_id) {
      base = legacyAgents.filter(a => a.agency_rea_id === pulseData.rea_agency_id);
    }
    if (base.length === 0 && !USE_DOSSIER_RPC && pulseData) {
      const name = normName(pulseData.name || crmEntity?.name);
      if (name) base = legacyAgents.filter(a => normName(a.agency_name) === name);
    }
    return sortRoster(base, rosterSort, rosterSortDir);
  }, [USE_DOSSIER_RPC, dossier, entityType, pulseData, crmEntity, legacyAgents, rosterSort, rosterSortDir]);

  // AG06: aggregate sales_breakdown from roster for the agency dossier chart.
  const rosterSalesBreakdown = useMemo(
    () => aggregateRosterSalesBreakdown(agencyAgents),
    [agencyAgents]
  );

  // #25: per-suburb ranking from agency listings (agency dossier only).
  const suburbRanking = useMemo(
    () => (entityType === "agency" ? computeSuburbRanking(entityListings) : []),
    [entityType, entityListings]
  );

  // #28: toggle a single agent id in the bulk-select set (uncrm'd only).
  const toggleAgentSelection = useCallback((ag) => {
    if (!ag) return;
    const mapping = agentMappingIndex.get(`pid:${ag.id}`) || (ag.rea_agent_id ? agentMappingIndex.get(`rea:${ag.rea_agent_id}`) : null);
    if (mapping?.crm_entity_id) return; // already in CRM — not selectable
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(ag.id)) next.delete(ag.id);
      else next.add(ag.id);
      return next;
    });
    // Note: agentMappingIndex is defined below — useCallback captures by closure
    // at next render, so an initial-render toggle is fine because state starts
    // empty. Keeping the dep array empty avoids circular useCallback deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // #28: bulk add uncrm'd selected agents to CRM. Fails-soft per row.
  const handleBulkAddAgentsToCrm = useCallback(async () => {
    if (selectedAgentIds.size === 0) return;
    setBulkAddingToCrm(true);
    let ok = 0, fail = 0;
    try {
      const targets = agencyAgents.filter((ag) => selectedAgentIds.has(ag.id));
      for (const ag of targets) {
        try {
          // Resolve / create agency for this agent (defaults to current)
          let agencyId = null;
          if (ag.agency_rea_id) {
            const { data: existing } = await supabase
              .from("agencies")
              .select("id")
              .eq("rea_agency_id", ag.agency_rea_id)
              .maybeSingle();
            agencyId = existing?.id || null;
          }
          if (!agencyId && ag.agency_name) {
            const newAg = await api.entities.Agency.create({
              name: ag.agency_name,
              rea_agency_id: ag.agency_rea_id || null,
              source: "pulse",
            });
            agencyId = newAg?.id;
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
      await refetchEntityList("PulseCrmMapping").catch(() => {});
      await refetchEntityList("PulseAgent").catch(() => {});
      await refetchEntityList("Agent").catch(() => {});
      await refetchDossier();
      if (ok > 0) toast.success(`Added ${ok} agent${ok > 1 ? "s" : ""} to CRM${fail > 0 ? ` (${fail} failed)` : ""}`);
      if (ok === 0 && fail > 0) toast.error(`All ${fail} adds failed. Check console.`);
      setSelectedAgentIds(new Set());
    } finally {
      setBulkAddingToCrm(false);
    }
  }, [selectedAgentIds, agencyAgents, refetchDossier]);

  // #29: export roster CSV (UTF-8 BOM).
  const handleExportRoster = useCallback(() => {
    if (!agencyAgents || agencyAgents.length === 0) return;
    const header = [
      "full_name", "email", "mobile", "job_title",
      "sales_as_lead", "reviews_avg", "is_in_crm",
    ];
    const rows = agencyAgents.map((ag) => {
      const mapping = agentMappingIndex.get(`pid:${ag.id}`) || (ag.rea_agent_id ? agentMappingIndex.get(`rea:${ag.rea_agent_id}`) : null);
      return {
        full_name: ag.full_name || "",
        email: ag.email || "",
        mobile: ag.mobile || ag.business_phone || "",
        job_title: ag.job_title || "",
        sales_as_lead: ag.sales_as_lead ?? ag.total_sold_12m ?? "",
        reviews_avg: ag.reviews_avg ?? ag.rea_rating ?? "",
        is_in_crm: mapping?.crm_entity_id ? "true" : "false",
      };
    });
    const slug = (pulseData?.name || "agency")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    exportCsvWithBom(
      `roster_${slug}_${new Date().toISOString().slice(0, 10)}.csv`,
      header, rows
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencyAgents, pulseData]);

  // #24: deep-link to Listings tab filtered to this agency.
  const handleViewAllAgencyListings = useCallback(() => {
    const reaId = pulseData?.rea_agency_id || crmEntity?.rea_agency_id;
    if (!reaId) return;
    navigate(`/IndustryPulse?tab=listings&agency_rea_id=${encodeURIComponent(reaId)}`);
  }, [pulseData, crmEntity, navigate]);

  // Sales breakdown / suburbs — derived from pulse_record, path-independent
  const salesBreakdown = useMemo(
    () => parseJSON(pulseData?.sales_breakdown, "sales_breakdown"),
    [pulseData]
  );
  const suburbsList = useMemo(
    () => parseArray(pulseData?.suburbs_active, "suburbs_active"),
    [pulseData]
  );

  // AG15: memoize primary/alternate contact lookups so they don't re-run
  // on every re-render. Keyed on the raw entity field + its alternate_* column
  // so swapping to a different pulse_record invalidates the cache.
  const agentMobInfo = useMemo(
    () => (entityType === "agent" ? primaryContact(pulseData, "mobile") : { value: null }),
    [entityType, pulseData?.mobile, pulseData?.mobile_source, pulseData?.mobile_confidence, pulseData?.alternate_mobiles]
  );
  const agentBizInfo = useMemo(
    () => (entityType === "agent" ? primaryContact(pulseData, "business_phone") : { value: null }),
    [entityType, pulseData?.business_phone, pulseData?.business_phone_source, pulseData?.business_phone_confidence, pulseData?.alternate_phones]
  );
  const agentEmailInfo = useMemo(
    () => (entityType === "agent" ? primaryContact(pulseData, "email") : { value: null }),
    [entityType, pulseData?.email, pulseData?.email_source, pulseData?.email_confidence, pulseData?.alternate_emails]
  );
  const agentAltMobiles = useMemo(
    () => (entityType === "agent" ? alternateContacts(pulseData, "mobile") : []),
    [entityType, pulseData?.mobile, pulseData?.alternate_mobiles]
  );
  const agentAltBizPhones = useMemo(
    () => (entityType === "agent" ? alternateContacts(pulseData, "business_phone") : []),
    [entityType, pulseData?.business_phone, pulseData?.alternate_phones]
  );
  const agentAltEmails = useMemo(
    () => (entityType === "agent" ? alternateContacts(pulseData, "email") : []),
    [entityType, pulseData?.email, pulseData?.alternate_emails]
  );

  const agencyPhoneInfo = useMemo(
    () => (entityType === "agency" ? primaryContact(pulseData, "phone") : { value: null }),
    [entityType, pulseData?.phone, pulseData?.phone_source, pulseData?.phone_confidence, pulseData?.alternate_phones]
  );
  const agencyEmailInfo = useMemo(
    () => (entityType === "agency" ? primaryContact(pulseData, "email") : { value: null }),
    [entityType, pulseData?.email, pulseData?.email_source, pulseData?.email_confidence, pulseData?.alternate_emails]
  );

  // Cross-reference: pulse listings matching CRM project addresses
  const projectAddresses = useMemo(
    () => new Set(entityProjects.map(p => normAddr(p.property_address))),
    [entityProjects]
  );
  const crossLinked = entityListings.filter(l => projectAddresses.has(normAddr(l.address)));

  // Agent→CRM mapping index (for agency roster click-through).
  // RPC: each roster row already carries `crm_mapping`, so the index stays
  // tiny. Legacy: rebuild from pulse_crm_mappings.
  const agentMappingIndex = useMemo(() => {
    const idx = new Map();
    if (USE_DOSSIER_RPC) {
      for (const a of agencyAgents) {
        if (a.crm_mapping && a.crm_mapping.entity_type === "agent") {
          if (a.crm_mapping.pulse_entity_id) idx.set(`pid:${a.crm_mapping.pulse_entity_id}`, a.crm_mapping);
          if (a.crm_mapping.rea_id) idx.set(`rea:${a.crm_mapping.rea_id}`, a.crm_mapping);
        }
      }
      return idx;
    }
    for (const m of legacyMappings) {
      if (m.entity_type === "agent") {
        if (m.pulse_entity_id) idx.set(`pid:${m.pulse_entity_id}`, m);
        if (m.rea_id) idx.set(`rea:${m.rea_id}`, m);
      }
    }
    return idx;
  }, [USE_DOSSIER_RPC, agencyAgents, legacyMappings]);

  // Agency mapping for agent dossier (clickable agency name). Under the RPC
  // path we don't preload every agency mapping, but the agent's agency_rea_id
  // is surfaced on pulseData so we can do a scoped fetch when needed. For now
  // this stays as a best-effort lookup that only resolves under legacy.
  // (The agent dossier's agency-name link simply stays non-clickable when the
  // mapping isn't known — no functional regression.)
  const agencyMapping = useMemo(() => {
    if (USE_DOSSIER_RPC) return null;
    if (!pulseData?.agency_rea_id) return null;
    return legacyMappings.find(m => m.entity_type === "agency" && m.rea_id === pulseData.agency_rea_id);
  }, [USE_DOSSIER_RPC, pulseData, legacyMappings]);

  /* ── IP03: Confirm/Reject mapping handlers ─────────────────────────────── */
  const handleConfirmMapping = useCallback(async () => {
    if (!mapping?.id) return;
    setMappingActionBusy(true);
    try {
      const { error } = await supabase
        .from("pulse_crm_mappings")
        .update({ confidence: "confirmed" })
        .eq("id", mapping.id);
      if (error) throw error;
      toast.success("Mapping confirmed");
      await refetchEntityList("PulseCrmMapping").catch(() => {});
      await refetchDossier();
    } catch (err) {
      console.error("Confirm mapping failed:", err);
      toast.error("Failed to confirm mapping");
    } finally {
      setMappingActionBusy(false);
    }
  }, [mapping, refetchDossier]);

  const handleRejectMapping = useCallback(async () => {
    if (!mapping?.id) return;
    setMappingActionBusy(true);
    try {
      const { error } = await supabase
        .from("pulse_crm_mappings")
        .delete()
        .eq("id", mapping.id);
      if (error) throw error;
      toast.success("Mapping rejected");
      await refetchEntityList("PulseCrmMapping").catch(() => {});
      await refetchDossier();
    } catch (err) {
      console.error("Reject mapping failed:", err);
      toast.error("Failed to reject mapping");
    } finally {
      setMappingActionBusy(false);
    }
  }, [mapping, refetchDossier]);

  /* ══════════════════════════════════════════════════════════════════════════ */
  /* ═══ EMPTY STATE ═══════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════════════ */

  if (coreLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!pulseData && !mapping && entityTimelineEntries.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground space-y-2">
        <Database className="h-8 w-8 mx-auto opacity-40" />
        <p className="text-sm font-medium">No Industry Pulse data linked</p>
        <p className="text-xs">
          This {entityType} hasn't been matched to pulse intelligence data yet.
          Run a data sync from Industry Pulse &rarr; Data Sources to populate agent/agency profiles.
        </p>
      </div>
    );
  }

  const a = pulseData; // shorthand

  /* ── Data freshness indicator ───────────────────────────────────────────── */
  const staleDays = a?.last_synced_at
    ? Math.floor((Date.now() - new Date(a.last_synced_at).getTime()) / 86400000)
    : null;

  /* ══════════════════════════════════════════════════════════════════════════ */
  /* ═══ RENDER ═══════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════════════ */

  return (
    <div className="space-y-4">

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ 1. HEADER BAR ═══════════════════════════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex items-center gap-2 flex-wrap text-xs px-1">
        {/* Mapping status */}
        {mapping ? (
          <Badge variant="outline" className={cn("text-[9px] gap-1",
            mapping.confidence === "confirmed"
              ? "text-green-600 border-green-200"
              : "text-amber-600 border-amber-200"
          )}>
            {mapping.confidence === "confirmed"
              ? <CheckCircle2 className="h-3 w-3" />
              : <AlertTriangle className="h-3 w-3" />}
            {mapping.confidence === "confirmed" ? "Confirmed" : "Suggested"}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[9px] text-muted-foreground">Unmapped</Badge>
        )}

        {/* IP03: Confirm / Reject inline for suggested mappings */}
        {mapping && mapping.confidence === "suggested" && (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] text-green-700 border-green-300 hover:bg-green-50 dark:hover:bg-green-950/20"
              disabled={mappingActionBusy}
              onClick={handleConfirmMapping}
              title="Confirm this mapping"
            >
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Confirm
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] text-red-700 border-red-300 hover:bg-red-50 dark:hover:bg-red-950/20"
              disabled={mappingActionBusy}
              onClick={handleRejectMapping}
              title="Reject this mapping"
            >
              <X className="h-3 w-3 mr-1" />
              Reject
            </Button>
          </div>
        )}

        {/* IP02: Add-to-CRM shortcut for unmapped dossiers (agent + agency) */}
        {!mapping && pulseData && (
          <Button
            size="sm"
            className="h-6 px-2 text-[10px] gap-1"
            onClick={() => setAddToCrmOpen(true)}
            title={`Create a CRM ${entityType} record from this dossier`}
          >
            <UserPlus className="h-3 w-3" />
            Add to CRM
          </Button>
        )}

        {/* REA ID badge */}
        {a?.rea_agent_id && (
          <Badge variant="outline" className="text-[8px] bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">
            REA {a.rea_agent_id}
          </Badge>
        )}
        {a?.rea_agency_id && (
          <Badge variant="outline" className="text-[8px] bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">
            REA {a.rea_agency_id}
          </Badge>
        )}

        {/* Data integrity score */}
        {a?.data_integrity_score > 0 && (() => {
          const ic = integrityColor(a.data_integrity_score);
          return (
            <Badge variant="outline" className={cn("text-[8px] gap-1", ic.text, ic.border, ic.badge)}>
              <Shield className="h-2.5 w-2.5" />
              {a.data_integrity_score}%
            </Badge>
          );
        })()}

        {/* Stale data warning */}
        {staleDays !== null && staleDays > 7 && (
          <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-300">
            Data {staleDays}d old
          </Badge>
        )}

        {/* Dates - right aligned */}
        <span className="text-[9px] text-muted-foreground ml-auto flex items-center gap-2">
          {a?.first_seen_at && <span>First seen {fmtDate(a.first_seen_at)}</span>}
          {a?.last_synced_at && <span>Synced {fmtDate(a.last_synced_at)}</span>}
        </span>
      </div>

      {/* Tab switcher — Overview / Listings. Gated on having listings so the
          bar doesn't appear for empty dossiers. Φ5 #7: agency dossiers now
          also render a Listings tab that mirrors the agent variant (filtered
          by agency_rea_id server-side by the dossier RPC). Minimal chip style
          matches the timeline filter chips below. */}
      {a && (activeListings.length > 0 || soldListings.length > 0) && (
        <div className="flex items-center gap-1.5 mt-2 mb-1" role="tablist" aria-label="Dossier sections">
          {[
            { key: "overview", label: "Overview" },
            {
              key: "listings",
              label: "Listings",
              count: activeListings.length + soldListings.length,
            },
          ].map(tab => {
            const isActive = dossierTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleDossierTabChange(tab.key)}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded-full border transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted/30 border-border/60 hover:bg-muted/60 text-foreground"
                )}
              >
                {tab.label}
                {typeof tab.count === "number" && (
                  <span className={cn(
                    "ml-1.5 text-[10px] opacity-80",
                    isActive ? "text-primary-foreground" : "text-muted-foreground"
                  )}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ AGENT DOSSIER ═══════════════════════════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {entityType === "agent" && a && (<>
        <div data-dossier-tab="overview" className="space-y-4 mt-2" hidden={dossierTab !== "overview"}>

        {/* ── 2. Profile Card ──────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              {a.profile_image ? (
                <img
                  src={a.profile_image}
                  alt=""
                  className="h-20 w-20 rounded-full object-cover shrink-0 border"
                />
              ) : (
                <div className="h-20 w-20 rounded-full bg-muted/60 flex items-center justify-center shrink-0 border">
                  <User className="h-8 w-8 text-muted-foreground/40" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-lg leading-tight">{a.full_name}</h3>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {a.job_title && <span className="text-xs text-muted-foreground">{a.job_title}</span>}
                  <Badge variant="outline" className={cn("text-[8px]", positionColor(mapPosition(a.job_title)))}>
                    {mapPosition(a.job_title)}
                  </Badge>
                  {a.years_experience && (
                    <span className="text-[10px] text-muted-foreground">{a.years_experience} yrs exp</span>
                  )}
                </div>

                {/* Agency line */}
                {a.agency_name && (
                  <div className="flex items-center gap-1.5 mt-1 text-xs">
                    <Building2 className="h-3 w-3 text-muted-foreground" />
                    {agencyMapping?.crm_entity_id ? (
                      <Link to={createPageUrl("OrgDetails") + `?id=${agencyMapping.crm_entity_id}`} replace={false} className="font-medium text-primary hover:underline">{a.agency_name}</Link>
                    ) : (
                      <span className="font-medium">{a.agency_name}</span>
                    )}
                    {a.suburb && <span className="text-muted-foreground">- {a.suburb}</span>}
                  </div>
                )}

                {/* Contact row — primary value + provenance badges. Legacy
                    `all_emails` extras still render below for backwards compat,
                    but the newer `alternate_emails` disclosure is preferred.
                    AG15: contact lookups are memoized at the component level.

                    2026-04-19 (Q5-fix): when ALL three primary contact fields
                    are null the row used to collapse silently, leaving no
                    feedback to the user. ~4,114 Pulse agents in the DB are
                    in this "zero contact" state (bridge-created stubs from
                    listing cross-enrichment that never supplied contact
                    info). We now render an amber alert so it's clear this
                    is a known enrichment gap, not a rendering bug. */}
                {(() => {
                  const mobInfo   = agentMobInfo;
                  const bizInfo   = agentBizInfo;
                  const emailInfo = agentEmailInfo;
                  const altBizPhones = agentAltBizPhones;
                  const altEmails = agentAltEmails;
                  const hasAnyContact = !!(mobInfo.value || bizInfo.value || emailInfo.value || altBizPhones.length > 0 || altEmails.length > 0);
                  return (
                    <div className="mt-1.5 space-y-1">
                      {!hasAnyContact && (
                        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          <div className="flex-1 leading-tight">
                            <span className="font-medium">No contact info yet.</span>{" "}
                            <span className="text-amber-800/80 dark:text-amber-300/80">
                              This agent was discovered via a listing but didn't include email/mobile details. Detail enrichment will backfill on the next sync (every 5 min).
                            </span>
                          </div>
                        </div>
                      )}
                      <div className="flex items-center gap-3 flex-wrap">
                        {mobInfo.value && (
                          <div className="flex items-center gap-1 text-xs">
                            <Phone className="h-3 w-3 text-muted-foreground" />
                            <a href={`tel:${mobInfo.value}`} className="text-primary hover:underline">{mobInfo.value}</a>
                            <ContactProvBadges info={mobInfo} />
                          </div>
                        )}
                        {bizInfo.value && !mobInfo.value && (
                          <div className="flex items-center gap-1 text-xs">
                            <Phone className="h-3 w-3 text-muted-foreground" />
                            <a href={`tel:${bizInfo.value}`} className="text-primary hover:underline">{bizInfo.value}</a>
                            <ContactProvBadges info={bizInfo} />
                          </div>
                        )}
                        {emailInfo.value && (
                          <div className="flex items-center gap-1 text-xs">
                            <Mail className="h-3 w-3 text-muted-foreground" />
                            <a href={`mailto:${emailInfo.value}`} className="text-primary hover:underline">{emailInfo.value}</a>
                            <ContactProvBadges info={emailInfo} />
                          </div>
                        )}
                        {/* Legacy all_emails renderer — kept for backwards compat
                            with pre-migration rows. Alternates via
                            alternate_emails take priority (rendered below). */}
                        {altEmails.length === 0 && (() => {
                          const allEmails = parseArray(a.all_emails, "all_emails");
                          const extras = allEmails.filter(e => e && e !== a.email);
                          return extras.map((em) => (
                            <div key={em} className="flex items-center gap-1 text-xs">
                              <Mail className="h-3 w-3 text-muted-foreground/50" />
                              <a href={`mailto:${em}`} className="text-primary/70 hover:underline">{em}</a>
                            </div>
                          ));
                        })()}
                      </div>
                      {/* Collapsed-by-default disclosures for alternate emails /
                          phones. Only render when the arrays have entries. */}
                      <AlternateContactsDisclosure entity={a} field="email" labelPlural="emails" icon={Mail} />
                      <AlternateContactsDisclosure entity={a} field="mobile" labelPlural="mobiles" icon={Phone} />
                      {altBizPhones.length > 0 && (
                        <AlternateContactsDisclosure entity={a} field="business_phone" labelPlural="business phones" icon={Phone} />
                      )}
                    </div>
                  );
                })()}

                {/* REA profile link */}
                {a.rea_profile_url && (
                  <a
                    href={a.rea_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1.5"
                  >
                    <ExternalLink className="h-3 w-3" /> View REA Profile
                  </a>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── 3. Performance Stats ─────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <SectionHeader icon={TrendingUp}>Performance</SectionHeader>
            <div className="grid grid-cols-3 gap-2">
              <StatBox value={a.sales_as_lead || 0} label="Sales (Lead, 12m)" />
              <StatBox value={fmtPrice(a.avg_sold_price)} label="Avg Sold Price" />
              <StatBox value={a.avg_days_on_market > 0 ? `${a.avg_days_on_market}d` : "\u2014"} label="Avg Days on Market" />
            </div>

            {/* Reviews row */}
            {(a.rea_rating > 0 || a.reviews_count > 0) && (
              <div className="flex items-center gap-3 pt-1">
                <Star className="h-5 w-5 fill-amber-400 text-amber-400" />
                <span className="text-xl font-bold">
                  {Number(a.rea_rating || a.reviews_avg || 0).toFixed(1)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {a.rea_review_count || a.reviews_count || 0} reviews
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active + Sold moved into Listings tab below (#71) */}

        {/* ── 6. Sales Breakdown — #74 clickable bars filter Listings tab */}
        {salesBreakdown && Object.keys(salesBreakdown).length > 0 && (
          <Card id="dossier-breakdown" className={cn("print-section-break transition-shadow", flashSection === "breakdown" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <SectionHeader icon={BarChart3}>Sales by Property Type</SectionHeader>
                {breakdownTypeFilter && (
                  <button
                    type="button"
                    onClick={() => setBreakdownTypeFilter(null)}
                    className="text-[9px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    title="Clear property-type filter"
                  >
                    <X className="h-2.5 w-2.5" /> Clear
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {Object.entries(salesBreakdown).map(([type, data]) => {
                  const maxCount = Math.max(...Object.values(salesBreakdown).map(d => d.count || 0), 1);
                  const pct = Math.round(((data.count || 0) / maxCount) * 100);
                  const isActive = breakdownTypeFilter === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setBreakdownTypeFilter(isActive ? null : type);
                        handleDossierTabChange("listings");
                      }}
                      className={cn(
                        "w-full text-left space-y-0.5 rounded px-1 py-0.5 transition-colors",
                        isActive ? "bg-red-50 dark:bg-red-950/20 ring-1 ring-red-400/40" : "hover:bg-muted/40"
                      )}
                      title={`Filter listings to ${type}`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="capitalize font-medium">{type}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {data.count} sold
                          {data.medianSoldPrice ? ` \u00B7 ${fmtPrice(data.medianSoldPrice)} median` : ""}
                          {data.medianDaysOnSite ? ` \u00B7 ${data.medianDaysOnSite}d DOM` : ""}
                        </span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className={cn("h-full rounded-full transition-all", isActive ? "bg-red-600 dark:bg-red-400" : "bg-red-400 dark:bg-red-500")} style={{ width: `${pct}%` }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 7. Awards ────────────────────────────────────────────────── */}
        {a.awards && (
          <Card id="dossier-awards" className={cn("print-section-break transition-shadow", flashSection === "awards" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <SectionHeader icon={Award}>Awards</SectionHeader>
              <div className="text-xs text-muted-foreground whitespace-pre-line bg-amber-50/50 dark:bg-amber-950/10 rounded p-2.5 border border-amber-200/30">
                {a.awards}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 7b. Biography ────────────────────────────────────────── */}
        {a.biography && (
          <Card className="print-section-break">
            <CardContent className="p-4">
              <SectionHeader icon={BookOpen}>About</SectionHeader>
              <p className="text-sm text-muted-foreground whitespace-pre-line">{a.biography}</p>
            </CardContent>
          </Card>
        )}

        {/* ── 8. Specialty Suburbs ─────────────────────────────────────── */}
        {suburbsList.length > 0 && (
          <Card id="dossier-suburbs" className={cn("print-section-break transition-shadow", flashSection === "suburbs" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <SectionHeader icon={MapPin}>Specialty Suburbs</SectionHeader>
              <div className="flex flex-wrap gap-1.5">
                {suburbsList.map(s => (
                  <Badge key={s} variant="outline" className="text-[9px] px-2 py-0.5 bg-red-50/50 dark:bg-red-950/10 border-red-200/50 text-red-700 dark:text-red-400">
                    {s}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 9. Social & Profile Links ────────────────────────────────── */}
        {(a.social_facebook || a.social_instagram || a.social_linkedin || a.rea_profile_url) && (
          <Card id="dossier-social" className={cn("print-section-break transition-shadow", flashSection === "social" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4 space-y-2">
              {(a.social_facebook || a.social_instagram || a.social_linkedin) && (
                <div>
                  <SectionHeader>Social</SectionHeader>
                  <div className="flex gap-3">
                    {a.social_facebook && (
                      <a href={a.social_facebook} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        <Facebook className="h-3.5 w-3.5" /> Facebook
                      </a>
                    )}
                    {a.social_instagram && (
                      <a href={`https://instagram.com/${a.social_instagram.replace("@", "")}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        <Instagram className="h-3.5 w-3.5" /> Instagram
                      </a>
                    )}
                    {a.social_linkedin && (
                      <a href={a.social_linkedin} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        <Linkedin className="h-3.5 w-3.5" /> LinkedIn
                      </a>
                    )}
                  </div>
                </div>
              )}
              {a.rea_profile_url && (
                <div className="pt-1 border-t">
                  <a href={a.rea_profile_url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink className="h-3 w-3" /> realestate.com.au <REABadge />
                  </a>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── 10. CRM Cross-Reference ────────────────────────────────────
            IP12: unmount the whole card when there's no mapping AND no
            cross-linked projects — nothing to show, no reason for chrome. */}
        {(mapping || entityProjects.length > 0) && (
          <Card id="dossier-crm" className={cn("print-section-break transition-shadow", flashSection === "crm" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <SectionHeader icon={Briefcase} count={entityProjects.length}>CRM Cross-Reference</SectionHeader>
              {mapping ? (
                // P1 #6: match AgentSlideout — the badge becomes a Link to
                // PersonDetails / OrgDetails when the mapping points at a CRM
                // record. Agent entities route to PersonDetails, agency ones
                // to OrgDetails.
                mapping.crm_entity_id ? (
                  <Link
                    to={createPageUrl(entityType === "agent" ? "PersonDetails" : "OrgDetails") + `?id=${mapping.crm_entity_id}`}
                    className="inline-block mb-2"
                    title={`Open CRM ${entityType} record`}
                  >
                    <Badge variant="outline" className="text-[9px] text-green-600 border-green-200 hover:bg-green-50 dark:hover:bg-green-950/20 transition-colors cursor-pointer">
                      <CheckCircle2 className="h-3 w-3 mr-1" /> Mapped to CRM
                      <ExternalLink className="h-2.5 w-2.5 ml-1" />
                    </Badge>
                  </Link>
                ) : (
                  <Badge variant="outline" className="text-[9px] text-green-600 border-green-200 mb-2">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Mapped to CRM
                  </Badge>
                )
              ) : (
                <p className="text-xs text-muted-foreground/60 mb-2">Not in CRM</p>
              )}
              {entityProjects.length > 0 ? (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {entityProjects.slice(0, 15).map(p => {
                    const isCrossLinked = crossLinked.some(l => normAddr(l.address) === normAddr(p.property_address));
                    return (
                      <div key={p.id} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/20">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{p.title || p.property_address}</p>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Badge variant="outline" className={cn("text-[7px] py-0",
                              p.status === "delivered" ? "text-green-600 border-green-200" :
                              p.status === "scheduled" ? "text-blue-600 border-blue-200" :
                              "text-muted-foreground"
                            )}>{p.status}</Badge>
                            {p.shoot_date && <span>{fmtDate(p.shoot_date)}</span>}
                          </div>
                        </div>
                        {isCrossLinked && (
                          <Badge className="text-[7px] bg-indigo-100 text-indigo-700 border-0 shrink-0 ml-2">
                            Pulse Match
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : mapping ? (
                <p className="text-xs text-muted-foreground/60">No projects found for this agent</p>
              ) : null}
            </CardContent>
          </Card>
        )}

        {/* ── 11. Enrichment Metadata (collapsible) ────────────────────── */}
        <Card>
          <CardContent className="p-0">
            <button
              onClick={() => setMetadataOpen(prev => !prev)}
              className="flex items-center justify-between w-full px-4 py-3 text-xs text-muted-foreground hover:bg-muted/20 transition-colors"
            >
              <span className="font-semibold uppercase flex items-center gap-1.5">
                <Hash className="h-3 w-3" /> Enrichment Metadata
              </span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", metadataOpen && "rotate-180")} />
            </button>
            {metadataOpen && (
              <div className="px-4 pb-3 space-y-2 text-[10px] text-muted-foreground border-t">
                <div className="flex items-center gap-2 pt-2">
                  <span className="font-medium">Source:</span> <REABadge />
                </div>
                {a?.data_integrity_score > 0 && (() => {
                  const ic = integrityColor(a.data_integrity_score);
                  return (
                    <div className="space-y-0.5">
                      <span className="font-medium">Data Integrity: <span className={ic.text}>{a.data_integrity_score}%</span></span>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden w-32">
                        <div className={cn("h-full rounded-full", ic.bg)} style={{ width: `${a.data_integrity_score}%` }} />
                      </div>
                    </div>
                  );
                })()}
                <div className="flex items-center gap-4 flex-wrap">
                  <span>First detected: {fmtDate(a?.first_seen_at)}</span>
                  <span>Last synced: {fmtDate(a?.last_synced_at)}</span>
                </div>
                {/* Tier 4: last_sync_log_id drill + full source history */}
                {/* P0 #3: open the SourceDrillDrawer in-place instead of
                    navigating away (which would drop the slideout stack). */}
                {a?.last_sync_log_id && (
                  <p>
                    Last sync run:{" "}
                    <button
                      type="button"
                      onClick={() => handleOpenSyncLog(a.last_sync_log_id)}
                      className="font-mono text-primary hover:underline inline-flex items-center gap-0.5"
                      title="Open payload for this run"
                    >
                      {String(a.last_sync_log_id).slice(0, 8)}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </button>
                  </p>
                )}
                {a?.rea_agent_id && <p>REA Agent ID: <span className="font-mono">{a.rea_agent_id}</span></p>}
                {a?.agency_rea_id && <p>REA Agency ID: <span className="font-mono">{a.agency_rea_id}</span></p>}
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-7 text-[10px]"
                    onClick={() => setSyncHistoryOpen(true)}
                    title="See which sync runs touched this agent"
                  >
                    <History className="h-3 w-3" />
                    View full source history
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        </div>

        {/* ── Listings tab (agent): Active + Sold, filtered by breakdown click */}
        <div data-dossier-tab="listings" className="space-y-4 mt-2" hidden={dossierTab !== "listings"}>
          <Card id="dossier-active" className={cn("print-section-break transition-shadow", flashSection === "active" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2 mb-1">
                <SectionHeader icon={Home} count={activeListings.length}>Active Listings</SectionHeader>
                {breakdownTypeFilter && (
                  <span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground">
                    <Filter className="h-2.5 w-2.5" />
                    filter: <span className="capitalize font-medium text-foreground">{breakdownTypeFilter}</span>
                    <button type="button" onClick={() => setBreakdownTypeFilter(null)} className="text-[9px] hover:text-foreground inline-flex items-center">
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                )}
              </div>
              {(() => {
                const rows = breakdownTypeFilter
                  ? activeListings.filter(l => (l.property_type || "").toLowerCase() === breakdownTypeFilter.toLowerCase())
                  : activeListings;
                return rows.length > 0 ? (
                  <div className="space-y-1 max-h-72 overflow-y-auto print-expand">
                    {rows.slice(0, 20).map(l => (<ListingRow key={l.id} l={l} />))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/60">
                    {breakdownTypeFilter ? `No active ${breakdownTypeFilter} listings` : "No active listings found"}
                  </p>
                );
              })()}
            </CardContent>
          </Card>

          <Card id="dossier-sold" className={cn("print-section-break transition-shadow", flashSection === "sold" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <SectionHeader icon={DollarSign} count={soldListings.length}>Recently Sold</SectionHeader>
              {(() => {
                const rows = breakdownTypeFilter
                  ? soldListings.filter(l => (l.property_type || "").toLowerCase() === breakdownTypeFilter.toLowerCase())
                  : soldListings;
                return rows.length > 0 ? (
                  <div className="space-y-1 max-h-64 overflow-y-auto print-expand">
                    {rows.slice(0, 20).map(l => (<ListingRow key={l.id} l={l} showSoldInfo />))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/60">No sold listings found</p>
                );
              })()}
            </CardContent>
          </Card>
        </div>
      </>)}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ AGENCY DOSSIER ══════════════════════════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {entityType === "agency" && a && (<>
        <div data-dossier-tab="overview" className="space-y-4 mt-2" hidden={dossierTab !== "overview"}>

        {/* ── 2. Agency Profile Card ─────────────────────────────────────
            AG07: brand color accent — 3px top-border in brand_color_primary +
            ~6% tinted bg when populated (~7% coverage). Fallback: no border,
            default bg, identical legacy look. Logo rendered circular (~40px)
            when logo_url is present (~90% coverage). */}
        {(() => {
          const brand = hexToRgba(a.brand_color_primary, 1);
          const tint = hexToRgba(a.brand_color_primary, 0.06);
          const cardStyle = brand
            ? { borderTop: `3px solid ${brand}`, backgroundColor: tint }
            : undefined;
          return (
            <Card id="dossier-profile" style={cardStyle} className={cn("print-section-break transition-shadow", flashSection === "profile" && "ring-2 ring-primary/60 ring-offset-2")}>
              <CardContent className="p-4">
                <div className="flex items-start gap-4">
                  {a.logo_url ? (
                    <img
                      src={a.logo_url}
                      alt=""
                      className="h-12 w-12 object-contain shrink-0 rounded-full border bg-white p-0.5"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded-full border bg-muted/40 flex items-center justify-center shrink-0">
                      <Building2 className="h-5 w-5 text-muted-foreground/40" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    {/* #31: agency name — 6% brand bg chip when populated. */}
                    <h3
                      className="font-bold text-lg leading-tight rounded px-1 -mx-1 inline-block"
                      style={
                        brand
                          ? { backgroundColor: hexToRgba(a.brand_color_primary, 0.06) }
                          : undefined
                      }
                    >{a.name}</h3>
                    {(a.suburb || a.address) && (
                      (() => {
                        const parts = [
                          a.address || a.suburb,
                          a.state ? `, ${a.state}` : "",
                          a.postcode ? ` ${a.postcode}` : "",
                        ].filter(Boolean).join("");
                        // #30: if we have a meaningful address, render the
                        // Copy + Maps cluster. Otherwise keep the plain pin.
                        const hasFullAddr = !!a.address;
                        return hasFullAddr ? (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            <AddressCluster address={parts} />
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                            <MapPin className="h-3 w-3" />
                            {parts}
                          </div>
                        );
                      })()
                    )}
                    {/* Contact row — with primary + alternates for email/phone.
                        email is NEW on pulse_agencies (migration 108+).
                        AG15: contact lookups memoized at the component level. */}
                    {(() => {
                      const phoneInfo = agencyPhoneInfo;
                      const emailInfo = agencyEmailInfo;
                      return (
                        <div className="mt-1.5 space-y-1">
                          <div className="flex items-center gap-3 flex-wrap">
                            {phoneInfo.value && (
                              <div className="group flex items-center gap-1 text-xs">
                                <Phone className="h-3 w-3 text-muted-foreground" />
                                <a href={`tel:${phoneInfo.value}`} className="text-primary hover:underline">{phoneInfo.value}</a>
                                <ContactProvBadges info={phoneInfo} />
                                <CopyInlineButton value={phoneInfo.value} label="Copy phone" />
                              </div>
                            )}
                            {emailInfo.value && (
                              <div className="group flex items-center gap-1 text-xs">
                                <Mail className="h-3 w-3 text-muted-foreground" />
                                <a href={`mailto:${emailInfo.value}`} className="text-primary hover:underline">{emailInfo.value}</a>
                                <ContactProvBadges info={emailInfo} />
                                <CopyInlineButton value={emailInfo.value} label="Copy email" />
                              </div>
                            )}
                            {a.website && (
                              <div className="group flex items-center gap-1 text-xs">
                                <Globe className="h-3 w-3 text-muted-foreground" />
                                <a
                                  href={a.website.startsWith("http") ? a.website : `https://${a.website}`}
                                  target="_blank" rel="noopener noreferrer"
                                  className="text-primary hover:underline truncate max-w-[200px]"
                                >{a.website}</a>
                                <CopyInlineButton value={a.website} label="Copy website" />
                              </div>
                            )}
                          </div>
                          <AlternateContactsDisclosure entity={a} field="email" labelPlural="emails" icon={Mail} />
                          <AlternateContactsDisclosure entity={a} field="phone" labelPlural="phones" icon={Phone} />
                        </div>
                      );
                    })()}
                    {a.rea_profile_url && (
                      <a
                        href={a.rea_profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1.5"
                      >
                        <ExternalLink className="h-3 w-3" /> View REA Profile
                      </a>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })()}

        {/* ── 2b. Head Office (migration 108+: HQ address) ─────────────────
            AG22: split out from the old "Branding" card so the section header
            doesn't say "Branding" when only an address is present (address
            coverage ~60%, brand colors ~7%). #30: address cluster with
            Copy + "Open in Maps" icons. */}
        {a.address_street && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={MapPin}>Head Office</SectionHeader>
              <div className="text-xs font-medium">
                <AddressCluster address={a.address_street} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 2c. Brand Identity (migration 108+: brand colors) ───────────
            AG22: only rendered when at least one brand color is populated. */}
        {(a.brand_color_primary || a.brand_color_text) && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={Palette}>Brand Identity</SectionHeader>
              <div className="flex items-center gap-3">
                {a.brand_color_primary && (
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-5 w-5 rounded border shadow-sm"
                      style={{ backgroundColor: a.brand_color_primary }}
                      title={`Primary: ${a.brand_color_primary}`}
                    />
                    <span className="text-[10px] font-mono text-muted-foreground">{a.brand_color_primary}</span>
                  </div>
                )}
                {a.brand_color_text && (
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-5 w-5 rounded border shadow-sm"
                      style={{ backgroundColor: a.brand_color_text }}
                      title={`Text: ${a.brand_color_text}`}
                    />
                    <span className="text-[10px] font-mono text-muted-foreground">{a.brand_color_text}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 3. Key Metrics (4-col grid) ──────────────────────────────── */}
        {(() => {
          // #31: brand-color left border on each StatBox when populated.
          const brandColor = hexToRgba(a.brand_color_primary, 1);
          // AG12: weighted fallback rating + tooltip when avg_agent_rating is
          // null (only ~9% populated) but we can compute from the roster.
          const ratedCount = agencyAgents.filter(
            (ag) => (ag?.reviews_avg || 0) > 0 && (ag?.reviews_count || 0) > 0
          ).length;
          let fallbackRating = null;
          if (ratedCount > 0) {
            const sumR = agencyAgents.reduce(
              (s, ag) => s + (ag.reviews_avg > 0 && ag.reviews_count > 0 ? ag.reviews_avg * ag.reviews_count : 0),
              0
            );
            const sumC = agencyAgents.reduce(
              (s, ag) => s + (ag.reviews_avg > 0 && ag.reviews_count > 0 ? ag.reviews_count : 0),
              0
            );
            fallbackRating = sumC > 0 ? +(sumR / sumC).toFixed(2) : null;
          }
          const displayRating = a.avg_agent_rating ?? fallbackRating ?? null;
          const isFallback = a.avg_agent_rating == null && fallbackRating != null;
          return (
            <Card>
              <CardContent className="p-4">
                <SectionHeader icon={TrendingUp}>Key Metrics</SectionHeader>
                <div className="grid grid-cols-4 gap-2">
                  <StatBox brandColor={brandColor || undefined} value={agencyAgents.length || a.agent_count || 0} label="Total Agents" />
                  <StatBox brandColor={brandColor || undefined} value={a.active_listings || 0} label="Active Listings" />
                  <StatBox brandColor={brandColor || undefined} value={a.total_sold_12m || 0} label="Sold (12m)" />
                  <StatBox
                    brandColor={brandColor || undefined}
                    title={
                      isFallback
                        ? `Computed from ${ratedCount} rostered agents' reviews`
                        : undefined
                    }
                    value={displayRating ? Number(displayRating).toFixed(1) : "\u2014"}
                    label="Avg Agent Rating"
                  />
                </div>
              </CardContent>
            </Card>
          );
        })()}

        {/* ── 4. Agent Roster ──────────────────────────────────────────── */}
        {agencyAgents.length > 0 && (
          <Card id="dossier-roster" className={cn("print-section-break transition-shadow", flashSection === "roster" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <SectionHeader icon={Users} count={agencyAgents.length}>Agent Roster</SectionHeader>
                {/* #29: Export roster CSV (UTF-8 BOM) */}
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
              </div>
              {/* #28: bulk add action bar */}
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
              <div className="border rounded-lg overflow-hidden print-expand">
                <table className="w-full text-xs">
                  {/* #31: thead tinted with 4% alpha of brand color when set */}
                  {(() => {
                    const brandThead = hexToRgba(a.brand_color_primary, 0.04);
                    return (
                      <thead
                        style={brandThead ? { backgroundColor: brandThead } : undefined}
                        className={cn(brandThead ? "" : "bg-muted/30")}
                      >
                        <tr>
                          {/* #28: checkbox column */}
                          <th className="px-2 py-1.5 w-6"></th>
                          {/* #75 — column sort */}
                          {(() => {
                            const ArrowIcon = rosterSortDir === "asc" ? ArrowUp : ArrowDown;
                            const col = (key, label) => (
                              <th
                                key={key}
                                className="px-2 py-1.5 font-semibold text-muted-foreground cursor-pointer select-none hover:text-foreground text-left"
                                onClick={() => handleRosterSortClick(key)}
                                aria-sort={rosterSort === key ? (rosterSortDir === "asc" ? "ascending" : "descending") : "none"}
                              >
                                <span className="inline-flex items-center gap-0.5">
                                  {label}
                                  {rosterSort === key && <ArrowIcon className="h-2.5 w-2.5" />}
                                </span>
                              </th>
                            );
                            return (
                              <>
                                {col("name", "Agent")}
                                {col("position", "Position")}
                                {col("sold", "Sold")}
                                {col("rating", "Rating")}
                                <th className="px-2 py-1.5 w-12"></th>
                              </>
                            );
                          })()}
                        </tr>
                      </thead>
                    );
                  })()}
                  <tbody>
                    {agencyAgents.slice(0, 30).map(ag => {
                      const agMapping = agentMappingIndex.get(`pid:${ag.id}`) || (ag.rea_agent_id ? agentMappingIndex.get(`rea:${ag.rea_agent_id}`) : null);
                      const hasCrm = !!agMapping?.crm_entity_id;
                      const checked = selectedAgentIds.has(ag.id);
                      // #23: every row drills through on click.
                      //   In CRM  -> PersonDetails (legacy)
                      //   Not CRM -> IndustryPulse dossier via ?pulse_id
                      // P1 #5: when a parent onOpenEntity is provided (slideout
                      // stack), prefer pushing a new dossier level onto the
                      // stack instead of navigating away.
                      const onRowClick = hasCrm
                        ? () => navigate(createPageUrl("PersonDetails") + `?id=${agMapping.crm_entity_id}`)
                        : () => handleTimelineOpenEntity({ type: "agent", id: ag.id });
                      return (
                        <tr
                          key={ag.id}
                          className="border-t hover:bg-muted/20 cursor-pointer"
                          onClick={onRowClick}
                        >
                          {/* #28: checkbox — only usable for uncrm'd */}
                          <td className="px-2 py-1.5 w-6" onClick={(e) => e.stopPropagation()}>
                            {!hasCrm ? (
                              <span
                                role="checkbox"
                                aria-checked={checked}
                                onClick={() => toggleAgentSelection(ag)}
                                className={cn(
                                  "inline-flex h-4 w-4 rounded border items-center justify-center cursor-pointer transition-colors",
                                  checked
                                    ? "bg-primary border-primary text-primary-foreground"
                                    : "border-border hover:border-primary/60"
                                )}
                                title={checked ? "Deselect" : "Select for bulk add to CRM"}
                              >
                                {checked && <Check className="h-3 w-3" />}
                              </span>
                            ) : (
                              <span className="inline-block h-4 w-4" aria-hidden />
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <p className="font-medium">{ag.full_name}</p>
                            {ag.job_title && <p className="text-[9px] text-muted-foreground">{ag.job_title}</p>}
                          </td>
                          <td className="px-2 py-1.5">
                            <Badge variant="outline" className={cn("text-[8px]", positionColor(mapPosition(ag.job_title)))}>
                              {mapPosition(ag.job_title)}
                            </Badge>
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">{ag.sales_as_lead || 0}</td>
                          <td className="px-2 py-1.5">
                            {(ag.rea_rating || ag.reviews_avg) > 0 ? (
                              <span className="flex items-center gap-0.5">
                                <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                                {Number(ag.rea_rating || ag.reviews_avg).toFixed(1)}
                              </span>
                            ) : "\u2014"}
                          </td>
                          <td className="px-2 py-1.5">
                            {hasCrm ? (
                              <Badge className="text-[7px] bg-green-100 text-green-700 border-0 px-1 py-0">CRM</Badge>
                            ) : (
                              <span className="text-[7px] text-muted-foreground/40">--</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Agency Listings moved to Listings tab below (#71) */}
        {/* #24: "View all listings" deep-link — filtered to this agency
            when pulse_record has a rea_agency_id. Other filters are cleared
            on arrival (the IndustryPulse Listings tab reads agency_rea_id
            and clears everything else). */}
        {(pulseData?.rea_agency_id || crmEntity?.rea_agency_id) && entityListings.length > 0 && (
          <div className="flex justify-end -mt-1">
            <button
              type="button"
              onClick={handleViewAllAgencyListings}
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline font-medium"
              title="Open the Listings tab filtered to this agency"
            >
              View all {entityListings.length} listings
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* ── 5b. Sales by Property Type (AG06) — #74 clickable filter ─
            pulse_agencies has no sales_breakdown column (0% populated), so
            we roll up the per-agent sales_breakdown jsonb across the roster. */}
        {rosterSalesBreakdown && Object.keys(rosterSalesBreakdown).length > 0 && (
          <Card id="dossier-breakdown" className={cn("print-section-break transition-shadow", flashSection === "breakdown" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <SectionHeader icon={BarChart3}>
                  Sales by Property Type
                  <span className="text-[9px] font-normal normal-case text-muted-foreground/70 ml-1">
                    rolled up from roster
                  </span>
                </SectionHeader>
                {breakdownTypeFilter && (
                  <button
                    type="button"
                    onClick={() => setBreakdownTypeFilter(null)}
                    className="text-[9px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    title="Clear property-type filter"
                  >
                    <X className="h-2.5 w-2.5" /> Clear
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {Object.entries(rosterSalesBreakdown).map(([type, data]) => {
                  const maxCount = Math.max(
                    ...Object.values(rosterSalesBreakdown).map((d) => d.count || 0),
                    1
                  );
                  const pct = Math.round(((data.count || 0) / maxCount) * 100);
                  const isActive = breakdownTypeFilter === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setBreakdownTypeFilter(isActive ? null : type);
                        handleDossierTabChange("listings");
                      }}
                      className={cn(
                        "w-full text-left space-y-0.5 rounded px-1 py-0.5 transition-colors",
                        isActive ? "bg-red-50 dark:bg-red-950/20 ring-1 ring-red-400/40" : "hover:bg-muted/40"
                      )}
                      title={`Filter listings to ${type}`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="capitalize font-medium">{type}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {data.count} sold
                          {data.medianSoldPrice ? ` \u00B7 ${fmtPrice(data.medianSoldPrice)} median` : ""}
                          {data.medianDaysOnSite ? ` \u00B7 ${data.medianDaysOnSite}d DOM` : ""}
                        </span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className={cn("h-full rounded-full transition-all", isActive ? "bg-red-600 dark:bg-red-400" : "bg-red-400 dark:bg-red-500")} style={{ width: `${pct}%` }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 6. Active Suburbs — #25: ranked by listing count ─
            Prefer listing-based ranking. Falls back to the flat chip cloud
            when no listings are available. */}
        {(suburbRanking.length > 0 || suburbsList.length > 0) && (
          <Card id="dossier-suburbs" className={cn("print-section-break transition-shadow", flashSection === "suburbs" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <SectionHeader icon={MapPin}>
                  {suburbRanking.length > 0 ? "Suburb Concentration" : "Active Suburbs"}
                </SectionHeader>
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
                  {suburbsList.map(s => (
                    <Badge key={s} variant="outline" className="text-[9px] px-2 py-0.5 bg-red-50/50 dark:bg-red-950/10 border-red-200/50 text-red-700 dark:text-red-400">
                      {s}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── 7. Enrichment Metadata (collapsible) ─────────────────────── */}
        <Card>
          <CardContent className="p-0">
            <button
              onClick={() => setMetadataOpen(prev => !prev)}
              className="flex items-center justify-between w-full px-4 py-3 text-xs text-muted-foreground hover:bg-muted/20 transition-colors"
            >
              <span className="font-semibold uppercase flex items-center gap-1.5">
                <Hash className="h-3 w-3" /> Enrichment Metadata
              </span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", metadataOpen && "rotate-180")} />
            </button>
            {metadataOpen && (
              <div className="px-4 pb-3 space-y-2 text-[10px] text-muted-foreground border-t">
                <div className="flex items-center gap-2 pt-2">
                  <span className="font-medium">Source:</span> <REABadge />
                </div>
                {a?.data_integrity_score > 0 && (() => {
                  const ic = integrityColor(a.data_integrity_score);
                  return (
                    <div className="space-y-0.5">
                      <span className="font-medium">Data Integrity: <span className={ic.text}>{a.data_integrity_score}%</span></span>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden w-32">
                        <div className={cn("h-full rounded-full", ic.bg)} style={{ width: `${a.data_integrity_score}%` }} />
                      </div>
                    </div>
                  );
                })()}
                <div className="flex items-center gap-4 flex-wrap">
                  <span>First detected: {fmtDate(a?.first_seen_at)}</span>
                  <span>Last synced: {fmtDate(a?.last_synced_at)}</span>
                </div>
                {/* Tier 4: last_sync_log_id drill + full source history */}
                {/* P0 #3: open the SourceDrillDrawer in-place instead of
                    navigating away (which would drop the slideout stack). */}
                {a?.last_sync_log_id && (
                  <p>
                    Last sync run:{" "}
                    <button
                      type="button"
                      onClick={() => handleOpenSyncLog(a.last_sync_log_id)}
                      className="font-mono text-primary hover:underline inline-flex items-center gap-0.5"
                      title="Open payload for this run"
                    >
                      {String(a.last_sync_log_id).slice(0, 8)}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </button>
                  </p>
                )}
                {a?.rea_agency_id && <p>REA Agency ID: <span className="font-mono">{a.rea_agency_id}</span></p>}
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-7 text-[10px]"
                    onClick={() => setSyncHistoryOpen(true)}
                    title="See which sync runs touched this agency"
                  >
                    <History className="h-3 w-3" />
                    View full source history
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        </div>

        {/* ── Listings tab (agency): Φ5 #7 — mirrors the agent listings tab
            but uses the dossier RPC's listings (already filtered by
            agency_rea_id server-side). Re-uses the same ListingRow +
            breakdown filter chip machinery. */}
        <div data-dossier-tab="listings" className="space-y-4 mt-2" hidden={dossierTab !== "listings"}>
          <Card id="dossier-active-agency" className={cn("print-section-break transition-shadow", flashSection === "active" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2 mb-1">
                <SectionHeader icon={Home} count={activeListings.length}>Active Listings</SectionHeader>
                {breakdownTypeFilter && (
                  <span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground">
                    <Filter className="h-2.5 w-2.5" />
                    filter: <span className="capitalize font-medium text-foreground">{breakdownTypeFilter}</span>
                    <button type="button" onClick={() => setBreakdownTypeFilter(null)} className="text-[9px] hover:text-foreground inline-flex items-center">
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                )}
              </div>
              {(() => {
                const rows = breakdownTypeFilter
                  ? activeListings.filter(l => (l.property_type || "").toLowerCase() === breakdownTypeFilter.toLowerCase())
                  : activeListings;
                return rows.length > 0 ? (
                  <div className="space-y-1 max-h-72 overflow-y-auto print-expand">
                    {rows.slice(0, 20).map(l => (<ListingRow key={l.id} l={l} />))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/60">
                    {breakdownTypeFilter ? `No active ${breakdownTypeFilter} listings` : "No active listings found"}
                  </p>
                );
              })()}
            </CardContent>
          </Card>

          <Card id="dossier-sold-agency" className={cn("print-section-break transition-shadow", flashSection === "sold" && "ring-2 ring-primary/60 ring-offset-2")}>
            <CardContent className="p-4">
              <SectionHeader icon={DollarSign} count={soldListings.length}>Recently Sold</SectionHeader>
              {(() => {
                const rows = breakdownTypeFilter
                  ? soldListings.filter(l => (l.property_type || "").toLowerCase() === breakdownTypeFilter.toLowerCase())
                  : soldListings;
                return rows.length > 0 ? (
                  <div className="space-y-1 max-h-64 overflow-y-auto print-expand">
                    {rows.slice(0, 20).map(l => (<ListingRow key={l.id} l={l} showSoldInfo />))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/60">No sold listings found</p>
                );
              })()}
            </CardContent>
          </Card>

          {/* Keep the "View all N listings" deep-link handy at the bottom of
              the listings tab too — the agency dossier's RPC may slice at
              ~100 rows, and this gives the user a full-list escape hatch. */}
          {(pulseData?.rea_agency_id || crmEntity?.rea_agency_id) && entityListings.length > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleViewAllAgencyListings}
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline font-medium"
                title="Open the Listings tab filtered to this agency"
              >
                View all {entityListings.length} listings
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </>)}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ 12. TIMELINE (both entity types) ═══════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <Card>
        <CardContent className="p-4">
          <SectionHeader icon={Clock}>Intelligence Timeline</SectionHeader>

          {/* Filter chips: 'all' vs the entity-type buckets surfaced by the
              aggregated RPC (migration 135). Lets the user pivot between
              events on the entity itself, its agents, and its listings
              without losing context. */}
          {timelineSummary.total > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              {(() => {
                const tabs = [
                  { key: "all", label: "All", count: timelineSummary.total },
                  {
                    key: "direct",
                    label: entityType === "agency" ? "This agency" : "This agent",
                    count: (timelineSummary.byEntityType[entityType] || 0),
                  },
                ];
                if (entityType === "agency") {
                  tabs.push({
                    key: "agent",
                    label: "Agents",
                    count: timelineSummary.byEntityType.agent || 0,
                  });
                }
                tabs.push({
                  key: "listing",
                  label: "Listings",
                  count: timelineSummary.byEntityType.listing || 0,
                });

                return tabs.map(tab => {
                  const isActive = timelineSourceFilter === tab.key;
                  const isDisabled = tab.count === 0 && tab.key !== "all";
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      disabled={isDisabled}
                      onClick={() => setTimelineSourceFilter(tab.key)}
                      className={cn(
                        "text-[11px] px-2.5 py-1 rounded-full border transition-colors",
                        isActive
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted/30 border-border/60 hover:bg-muted/60 text-foreground",
                        isDisabled && "opacity-40 cursor-not-allowed hover:bg-muted/30"
                      )}
                      title={isDisabled ? "No events in this bucket" : `Show ${tab.label.toLowerCase()} events`}
                    >
                      {tab.label}
                      <span className={cn(
                        "ml-1.5 text-[10px] opacity-80",
                        isActive ? "text-primary-foreground" : "text-muted-foreground"
                      )}>
                        {tab.count}
                      </span>
                    </button>
                  );
                });
              })()}
            </div>
          )}

          <PulseTimeline
            entries={filteredTimelineEntries}
            maxHeight="max-h-[500px]"
            emptyMessage={
              timelineSourceFilter === "all"
                ? `No timeline events for this ${entityType} yet. Events will appear after data syncs detect changes.`
                : `No events in this bucket. Try the "All" tab.`
            }
            showFilters
            onOpenEntity={handleTimelineOpenEntity}
            onOpenSyncLog={handleOpenSyncLog}
          />
        </CardContent>
      </Card>

      {/* Tier 4: source history dialog */}
      {syncHistoryOpen && a && (
        <EntitySyncHistoryDialog
          entityType={entityType}
          entityId={a.id}
          entityLabel={a.full_name || a.name || entityName}
          onClose={() => setSyncHistoryOpen(false)}
        />
      )}

      {/* IP02: Add-to-CRM dialog (agent or agency, routed via entityType) */}
      {addToCrmOpen && a && (
        <AddToCrmInlineDialog
          entityType={entityType}
          pulseRecord={a}
          onClose={() => setAddToCrmOpen(false)}
          onSuccess={async () => {
            setAddToCrmOpen(false);
            await refetchDossier();
          }}
        />
      )}

      {/* P0 #2 / #3: in-place sync-log drill drawer. Opened by sync-log
          external-link clicks on the timeline / Section 11 so the slideout
          stack stays intact. Resolves (source_id, started_at) via a scoped
          query, then feeds SourceDrillDrawer. */}
      {syncLogDrill && (
        <SyncLogDrillByIdDrawer
          syncLogId={syncLogDrill.syncLogId}
          onClose={() => setSyncLogDrill(null)}
        />
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════ */
/* ═══ SYNC-LOG DRILL DRAWER (by id) ═══════════════════════════════════════ */
/* ═════════════════════════════════════════════════════════════════════════════ */
/**
 * Resolves a pulse_sync_logs row by id → (source_id, started_at), then hands
 * off to the shared SourceDrillDrawer. Keeps callers (TimelineRow / Section 11
 * "Last sync run" link) decoupled from the drawer's (source, createdAt)
 * contract. Lightweight — a single maybeSingle query against the logs table.
 */
function SyncLogDrillByIdDrawer({ syncLogId, onClose }) {
  const { data } = useQuery({
    queryKey: ["sync-log-by-id", syncLogId],
    queryFn: async () => {
      if (!syncLogId) return null;
      const { data, error } = await supabase
        .from("pulse_sync_logs")
        .select("id, source_id, started_at")
        .eq("id", syncLogId)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
    enabled: !!syncLogId,
    staleTime: 60_000,
  });
  // SourceDrillDrawer expects open boolean + (source, createdAt). Render it
  // immediately (open) and let it show its own loading state until we resolve
  // the sync-log metadata. Close propagates up so the caller can clear state.
  return (
    <SourceDrillDrawer
      open
      source={data?.source_id || null}
      createdAt={data?.started_at || null}
      onClose={onClose}
    />
  );
}

/* ═════════════════════════════════════════════════════════════════════════════ */
/* ═══ INLINE "Add to CRM" DIALOG ═══════════════════════════════════════════ */
/* ═════════════════════════════════════════════════════════════════════════════ */
// Lightweight dialog that takes a pulse_agents / pulse_agencies row and
// creates the corresponding CRM Agent/Agency record + PulseCrmMapping in one
// flow. Separate from the beefier PulseAgentIntel dialog (which needs the
// cached CRM-agent/agency lists for dedup warnings) so we don't pull in 10k
// rows just to open a single-agent confirmation.

function AddToCrmInlineDialog({ entityType, pulseRecord, onClose, onSuccess }) {
  const [saving, setSaving] = useState(false);
  const isAgent = entityType === "agent";

  // #76 — dedup warning: hit the CRM for a potential duplicate before the
  // user confirms. OR-joined on email / phone / rea_id; first hit wins.
  const table = isAgent ? "agents" : "agencies";
  const dedupQuery = useQuery({
    queryKey: ["add-to-crm-dedup", entityType, pulseRecord?.id],
    queryFn: async () => {
      const email = pulseRecord?.email;
      const phone = isAgent
        ? (pulseRecord?.mobile || pulseRecord?.business_phone)
        : pulseRecord?.phone;
      const reaId = isAgent
        ? pulseRecord?.rea_agent_id
        : pulseRecord?.rea_agency_id;
      const clauses = [];
      if (email) clauses.push(`email.eq.${email}`);
      if (phone) clauses.push(`phone.eq.${phone}`);
      if (reaId) {
        const col = isAgent ? "rea_agent_id" : "rea_agency_id";
        clauses.push(`${col}.eq.${reaId}`);
      }
      if (clauses.length === 0) return null;
      const { data, error } = await supabase
        .from(table)
        .select("id,name,email,phone")
        .or(clauses.join(","))
        .limit(1)
        .maybeSingle();
      if (error && error.code !== "PGRST116") {
        // swallow — dedup is best-effort, don't block the dialog
        return null;
      }
      return data || null;
    },
    enabled: !!pulseRecord,
    staleTime: 30_000,
  });
  const duplicate = dedupQuery.data;
  const [dupAck, setDupAck] = useState(false);
  // If the duplicate clears (refetch returns null) auto-clear ack.
  useEffect(() => {
    if (!duplicate) setDupAck(false);
  }, [duplicate]);

  async function handleLinkToExisting() {
    if (!duplicate) return;
    setSaving(true);
    try {
      await api.entities.PulseCrmMapping.create({
        entity_type: entityType,
        pulse_entity_id: pulseRecord.id,
        crm_entity_id: duplicate.id,
        rea_id: isAgent ? (pulseRecord.rea_agent_id || null) : (pulseRecord.rea_agency_id || null),
        match_type: "manual",
        confidence: "confirmed",
      });
      if (isAgent) {
        await api.entities.PulseAgent.update(pulseRecord.id, { is_in_crm: true });
      } else {
        await api.entities.PulseAgency.update(pulseRecord.id, { is_in_crm: true });
      }
      await refetchEntityList("PulseCrmMapping").catch(() => {});
      toast.success(`Linked to existing ${isAgent ? "agent" : "agency"} ${duplicate.name}`);
      await onSuccess?.();
    } catch (err) {
      console.error("Link-to-existing failed:", err);
      toast.error("Link failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirm() {
    setSaving(true);
    try {
      if (isAgent) {
        // 1. Resolve agency (create if needed)
        let agencyId = null;
        if (pulseRecord.agency_rea_id) {
          const { data: existing } = await supabase
            .from("agencies")
            .select("id")
            .eq("rea_agency_id", pulseRecord.agency_rea_id)
            .limit(1)
            .maybeSingle();
          if (existing?.id) agencyId = existing.id;
        }
        if (!agencyId && pulseRecord.agency_name) {
          const newAgency = await api.entities.Agency.create({
            name: pulseRecord.agency_name,
            rea_agency_id: pulseRecord.agency_rea_id || null,
            source: "pulse",
            relationship_state: "Prospecting",
          });
          agencyId = newAgency?.id;
        }

        // 2. Create CRM agent
        const newAgent = await api.entities.Agent.create({
          name: pulseRecord.full_name,
          phone: pulseRecord.mobile || pulseRecord.business_phone || null,
          email: pulseRecord.email || null,
          current_agency_id: agencyId,
          rea_agent_id: pulseRecord.rea_agent_id || null,
          title: pulseRecord.job_title || null,
          // Q4-fix 2026-04-19: was "prospect" (lowercase) which isn't a valid
          // RELATIONSHIP_STATES enum value — downstream filters/dashboards
          // dropped these rows. Matches the capitalized form used in the
          // agency branch above.
          relationship_state: "Prospecting",
          source: "pulse",
        });

        // 3. Mapping + is_in_crm flag
        await api.entities.PulseCrmMapping.create({
          entity_type: "agent",
          pulse_entity_id: pulseRecord.id,
          crm_entity_id: newAgent.id,
          rea_id: pulseRecord.rea_agent_id || null,
          match_type: "manual",
          confidence: "confirmed",
        });
        await api.entities.PulseAgent.update(pulseRecord.id, { is_in_crm: true });

        await refetchEntityList("Agent").catch(() => {});
        await refetchEntityList("Agency").catch(() => {});
        await refetchEntityList("PulseAgent").catch(() => {});
        await refetchEntityList("PulseCrmMapping").catch(() => {});

        toast.success(`${pulseRecord.full_name} added to CRM`);
      } else {
        // Agency path
        const newAgency = await api.entities.Agency.create({
          name: pulseRecord.name,
          phone: pulseRecord.phone || null,
          email: pulseRecord.email || null,
          website: pulseRecord.website || null,
          rea_agency_id: pulseRecord.rea_agency_id || null,
          source: "pulse",
          relationship_state: "Prospecting",
        });

        await api.entities.PulseCrmMapping.create({
          entity_type: "agency",
          pulse_entity_id: pulseRecord.id,
          crm_entity_id: newAgency.id,
          rea_id: pulseRecord.rea_agency_id || null,
          match_type: "manual",
          confidence: "confirmed",
        });
        await api.entities.PulseAgency.update(pulseRecord.id, { is_in_crm: true });

        await refetchEntityList("Agency").catch(() => {});
        await refetchEntityList("PulseAgency").catch(() => {});
        await refetchEntityList("PulseCrmMapping").catch(() => {});

        toast.success(`${pulseRecord.name} added to CRM`);
      }

      await onSuccess?.();
    } catch (err) {
      console.error("Add to CRM failed:", err);
      toast.error("Failed to add to CRM. See console for details.");
    } finally {
      setSaving(false);
    }
  }

  const displayName = isAgent ? pulseRecord.full_name : pulseRecord.name;
  const subLine = isAgent
    ? (pulseRecord.agency_name || "Unknown agency")
    : (pulseRecord.suburb || pulseRecord.address_street || "");

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" />
            Add {isAgent ? "Agent" : "Agency"} to CRM
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-lg border border-border p-3">
            <p className="font-semibold text-sm">{displayName}</p>
            {subLine && <p className="text-xs text-muted-foreground">{subLine}</p>}
          </div>
          <div className="rounded-lg border border-border divide-y divide-border text-xs">
            {isAgent ? (
              <>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-muted-foreground">REA Agent ID</span>
                  <span className="font-mono text-[10px]">{pulseRecord.rea_agent_id || "\u2014"}</span>
                </div>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-muted-foreground">Mobile</span>
                  <span>{pulseRecord.mobile || "\u2014"}</span>
                </div>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-muted-foreground">Email</span>
                  <span className="truncate max-w-[200px]">{pulseRecord.email || "\u2014"}</span>
                </div>
              </>
            ) : (
              <>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-muted-foreground">REA Agency ID</span>
                  <span className="font-mono text-[10px]">{pulseRecord.rea_agency_id || "\u2014"}</span>
                </div>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-muted-foreground">Phone</span>
                  <span>{pulseRecord.phone || "\u2014"}</span>
                </div>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-muted-foreground">Website</span>
                  <span className="truncate max-w-[200px]">{pulseRecord.website || "\u2014"}</span>
                </div>
              </>
            )}
          </div>
          {/* #76 — duplicate warning */}
          {duplicate && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800/40 p-2.5 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs space-y-0.5 flex-1 min-w-0">
                  <p className="font-semibold text-amber-900 dark:text-amber-200">
                    Similar {isAgent ? "agent" : "agency"} exists
                  </p>
                  <p className="text-amber-800 dark:text-amber-300 truncate">
                    <span className="font-medium">{duplicate.name}</span>
                    {duplicate.email && <span className="text-muted-foreground"> · {duplicate.email}</span>}
                    {duplicate.phone && <span className="text-muted-foreground"> · {duplicate.phone}</span>}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to={createPageUrl(isAgent ? "PersonDetails" : "OrgDetails") + `?id=${duplicate.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  <ExternalLink className="h-2.5 w-2.5" /> Open existing
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  disabled={saving}
                  onClick={handleLinkToExisting}
                >
                  Link to existing instead
                </Button>
                <label className="inline-flex items-center gap-1 text-[10px] text-amber-900 dark:text-amber-200 ml-auto">
                  <input
                    type="checkbox"
                    checked={dupAck}
                    onChange={(e) => setDupAck(e.target.checked)}
                    className="h-3 w-3"
                  />
                  Create anyway (acknowledge duplicate)
                </label>
              </div>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            Creates a new CRM {isAgent ? "Agent" : "Agency"} record and a confirmed
            Pulse mapping so future syncs update this record.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={saving || (duplicate && !dupAck)}
            title={duplicate && !dupAck ? "Acknowledge the duplicate first, or Link to existing" : undefined}
          >
            {saving ? "Creating\u2026" : "Confirm & Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

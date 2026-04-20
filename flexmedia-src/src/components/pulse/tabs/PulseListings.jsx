/**
 * PulseListings — Listings tab for Industry Pulse.
 *
 * Server-side pagination (BG PP refactor):
 *   The table fetches ONE page at a time via .range() + count:exact directly
 *   against `pulse_listings`. This removes any dependency on the parent
 *   Pulse page's cached `pulseListings` array for table rendering — so the
 *   table scales to tens of thousands of rows without OOM.
 *
 *   Filters moved to server-side:
 *     - listing_type filter  -> .in("listing_type", [...])  (multi)
 *     - global search + column filter -> .or(ilike on address/suburb/agency_name/agent_name)
 *     - sort column + direction       -> .order(col, { ascending })
 *     - price range / photos range / first-seen range / DOM min
 *     - package / tier / enrichment-state multis — joined via
 *       pulse_listing_missed_opportunity substrate (same row PK as listings)
 *
 *   The parent's `pulseListings` prop is kept but now only used by the
 *   slideout for cross-referencing agents/agencies and by the parent's
 *   stat cards. Drill-through to a listing still works because the central
 *   dispatcher in IndustryPulse.jsx resolves by id against the cached array.
 *
 *   CSV export fetches the ENTIRE filtered set server-side (separate query,
 *   limit 10000 safety cap), not just the current page.
 *
 * Views:
 *   Top-level pill group switches between three visualisations:
 *     Table — the classic dense list (default).
 *     Grid  — responsive card grid, 3/4 columns, rich hero image and chips.
 *     Map   — Leaflet + clustered markers coloured by captured/missed state,
 *             popups with hero/price/package/quote.
 *   Current view is serialised to URL `?listings_view=` so bookmarks remember.
 */
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { createPageUrl } from "@/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Home,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  BedDouble,
  Bath,
  Car,
  User,
  Building2,
  X,
  Image as ImageIcon,
  Phone,
  Clock,
  Download,
  Loader2,
  History,
  FileImage,
  Video,
  Copy,
  Star,
  Camera,
  Columns3,
  Sparkles,
  Table as TableIcon,
  LayoutGrid,
  Map as MapIcon,
  Filter,
  Save,
  Eye,
  Zap,
  CheckCircle2,
  CircleDot,
  Bookmark,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import EntitySyncHistoryDialog from "@/components/pulse/EntitySyncHistoryDialog";
import AttachmentLightbox from "@/components/common/AttachmentLightbox";
import PropertyHistoryCard from "@/components/pulse/PropertyHistoryCard";
import QuoteInspector from "@/components/marketshare/QuoteInspector";
import EnrichmentBadge, {
  deriveEnrichmentState,
} from "@/components/marketshare/EnrichmentBadge";
import {
  QuoteProvenance,
  QuoteAmount,
  PackageBadge,
} from "@/components/marketshare/QuoteProvenance";
import {
  displayPrice as sharedDisplayPrice,
  stalenessInfo,
  formatAuctionDateTime,
  parseMediaItems,
} from "@/components/pulse/utils/listingHelpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
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

/**
 * Get a display date for a listing with smart fallback, returning both the
 * date and its source so the UI can indicate if it's an approximation.
 *
 * Priority:
 *   sold   -> sold_date -> derived from days_on_market -> listed_date -> first_seen_at
 *   other  -> listed_date -> derived from days_on_market + first_seen_at -> created_date -> first_seen_at
 *
 * Returns: { date: string|null, source: 'listed' | 'sold' | 'derived' | 'first_seen' | null }
 */
function getListingDisplayDate(listing) {
  if (!listing) return { date: null, source: null };

  const isSold = listing.listing_type === "sold";

  if (isSold) {
    if (listing.sold_date) return { date: listing.sold_date, source: "sold" };
    if (listing.listed_date) return { date: listing.listed_date, source: "listed" };
    // For sold listings, first_seen_at is when we first saw it in the "sold" section
    // on REA — so it's a reasonable proxy for sold date (within a sync cycle).
    if (listing.first_seen_at) return { date: listing.first_seen_at, source: "first_seen" };
    return { date: null, source: null };
  }

  if (listing.listed_date) return { date: listing.listed_date, source: "listed" };

  // Derive from DOM + first_seen_at for REA listings missing listed_date
  if (listing.days_on_market > 0 && listing.first_seen_at) {
    const seen = new Date(listing.first_seen_at);
    if (!isNaN(seen.getTime())) {
      const derived = new Date(seen.getTime() - listing.days_on_market * 86400000);
      return { date: derived.toISOString(), source: "derived" };
    }
  }

  if (listing.created_date) return { date: listing.created_date, source: "listed" };
  if (listing.first_seen_at) return { date: listing.first_seen_at, source: "first_seen" };
  return { date: null, source: null };
}

const DATE_SOURCE_LABEL = {
  listed: "Listed date",
  sold: "Sold date",
  derived: "Estimated from Days-on-Market (scraped value)",
  first_seen: "First seen on our platform — actual listing date unknown",
};

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

function exportCsv(filename, header, rows) {
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

// Type filters for the Listings table. Each button counts listing ROWS
// in `pulse_listings` (one listing = one row) — NOT unique properties.
// A single property that was sold twice counts twice; a property sold
// then re-listed still contributes its sold row here. Properties module
// ("Properties > Sold (current)") dedupes to one row per property_key
// and only surfaces properties whose LATEST listing is sold, so its
// total will always be ≤ this one.
const TYPE_FILTERS = [
  { value: "for_sale", label: "For Sale" },
  { value: "for_rent", label: "For Rent" },
  { value: "sold", label: "Sold", tooltip: "All sold listing rows (not unique properties). Properties module dedupes by address and shows fewer." },
  { value: "under_contract", label: "Under Contract" },
];

const TYPE_BADGE = {
  for_sale: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  sold: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  for_rent: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  under_contract: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

const TYPE_LABEL = {
  for_sale: "For Sale",
  sold: "Sold",
  for_rent: "For Rent",
  under_contract: "Under Contract",
};

// Package classifications as they surface in pulse_listing_missed_opportunity.
// Ordered most-valuable-first so the multi-select reads naturally.
const PACKAGE_OPTIONS = [
  "Flex",
  "Dusk Video",
  "Day Video",
  "AI",
  "Gold",
  "Silver",
  "UNCLASSIFIABLE",
];

const TIER_OPTIONS = [
  { value: "standard", label: "std" },
  { value: "premium", label: "prm" },
];

const ENRICHMENT_OPTIONS = [
  { value: "fresh", label: "Fresh" },
  { value: "pending", label: "Pending" },
  { value: "stale", label: "Stale" },
];

const VIEW_OPTIONS = [
  { value: "table", label: "Table", Icon: TableIcon },
  { value: "grid", label: "Grid", Icon: LayoutGrid },
  { value: "map", label: "Map", Icon: MapIcon },
];

// ── Thumbnail ─────────────────────────────────────────────────────────────────

function Thumb({ src }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="w-12 h-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
        <ImageIcon className="h-3 w-3 text-muted-foreground/40" />
      </div>
    );
  }
  // #34: hover preview — 300x200 popover of the same image.
  return (
    <HoverCard openDelay={250} closeDelay={50}>
      <HoverCardTrigger asChild>
        <img
          src={src}
          alt=""
          className="w-12 h-8 rounded object-cover flex-shrink-0 cursor-zoom-in"
          onError={() => setErr(true)}
        />
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="p-0 w-auto border-0 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt=""
          style={{ width: 300, height: 200 }}
          className="object-cover rounded-md"
        />
      </HoverCardContent>
    </HoverCard>
  );
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIcon({ col, sort }) {
  if (sort.col !== col) return <ArrowUpDown className="h-3 w-3 opacity-30" />;
  return sort.dir === "asc"
    ? <ArrowUp className="h-3 w-3 text-primary" />
    : <ArrowDown className="h-3 w-3 text-primary" />;
}

// ── Listing slideout ──────────────────────────────────────────────────────────

export function ListingSlideout({
  listing,
  pulseAgents,
  pulseAgencies = [],
  onClose,
  onOpenEntity,
  hasHistory = false,
  onBack,
  // Φ3 P0 #3: `?slideout_tab=<name>` deep-linking. Parity with Agent/Agency
  // slideouts — IndustryPulse threads slideoutTabParam for all 3 entity types.
  // Valid names map to on-screen sections we scroll into view.
  initialTab,
}) {
  const [heroErr, setHeroErr] = useState(false);
  // Tier 4: source-history drill
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
  // LS09: lightbox index for gallery click-through
  const [lightboxIndex, setLightboxIndex] = useState(null);
  // Φ3 P0 #3: tab state. Seeded from initialTab, updated if the prop changes
  // (e.g. user navigates to a different section while the slideout is open).
  const [tab, setTab] = useState(initialTab ?? "overview");
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  // Refs used to scroll the requested section into view when `tab` changes.
  const galleryRef = useRef(null);
  const floorplansRef = useRef(null);
  const historyRef = useRef(null);
  const quoteRef = useRef(null);
  useEffect(() => {
    // Map tab names -> section refs. Overview = no scroll (top of dialog).
    const target = {
      gallery: galleryRef.current,
      photos: galleryRef.current,
      floorplans: floorplansRef.current,
      history: historyRef.current,
      timeline: historyRef.current,
      quote: quoteRef.current,
      inspector: quoteRef.current,
    }[tab];
    if (target) {
      // Defer one frame so the dialog finishes mounting first.
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [tab]);

  // Fetch the missed-opportunity row for this listing so we can surface
  // tier + tier_source inline at the top of the slideout (not just inside
  // QuoteInspector further down). Reuses the same row the table would have
  // loaded — react-query's cache will dedupe if the table already fetched it.
  const { data: slideoutMo } = useQuery({
    enabled: !!listing?.id,
    queryKey: ["pulse-mo-single", listing?.id],
    queryFn: async () => {
      const { data } = await api._supabase
        .from("pulse_listing_missed_opportunity")
        .select("listing_id,classified_package_name,resolved_tier,quoted_price,quote_status,tier_source")
        .eq("listing_id", listing.id)
        .maybeSingle();
      return data || null;
    },
    staleTime: 60_000,
  });

  if (!listing) return null;

  // Canonical price label via shared helper — handles sold/rent/under_contract
  // ordering + /wk suffix in one place. See listingHelpers.js.
  const displayPriceLabel = sharedDisplayPrice(listing).label;

  const heroSrc = !heroErr && (listing.hero_image || listing.image_url);

  // Cross-reference: find pulse agent record
  const linkedAgent = listing.agent_rea_id
    ? pulseAgents.find((a) => a.rea_agent_id === listing.agent_rea_id)
    : null;

  // Cross-reference: find pulse agency record
  const linkedAgency = listing.agency_rea_id
    ? pulseAgencies.find((a) => a.rea_agency_id === listing.agency_rea_id)
    : null;

  // Display date with fallback + source indicator
  const { date: displayDate, source: dateSource } = getListingDisplayDate(listing);

  // Prefer detail-enriched `media_items` (full set, photos only) with fallback
  // to legacy `images[]`. No slice — gallery shows every photo the scraper
  // returned (memo23 typically caps at ~16-40 per listing). Flex: grid wraps.
  let images = [];
  const mediaParsed = parseMediaItems(listing);
  if (mediaParsed.photos.length > 0) {
    images = mediaParsed.photos.map((p) => p.url);
  } else {
    try {
      if (Array.isArray(listing.images)) images = listing.images;
      else if (typeof listing.images === "string") images = JSON.parse(listing.images);
    } catch {
      images = [];
    }
  }

  const address = [listing.address, listing.suburb, listing.postcode]
    .filter(Boolean)
    .join(", ");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {/* Hero image */}
        {heroSrc && (
          <div className="w-full bg-muted overflow-hidden rounded-t-lg" style={{ maxHeight: 300 }}>
            <img
              src={heroSrc}
              alt="Listing hero"
              className="w-full object-cover"
              style={{ maxHeight: 300 }}
              onError={() => setHeroErr(true)}
            />
          </div>
        )}

        <div className="p-5 space-y-4">
          <DialogHeader className="pb-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 flex-1 min-w-0">
                {hasHistory && onBack && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 flex-shrink-0 -ml-1"
                    onClick={onBack}
                    title="Back"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                )}
                <div className="flex-1 min-w-0">
                  <DialogTitle className="text-base font-semibold leading-tight">
                    {address || "Unknown address"}
                  </DialogTitle>
                  <div className="mt-1 flex items-center gap-1.5">
                    <EnrichmentBadge listing={listing} size="sm" />
                  </div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={onClose}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </DialogHeader>

          {/* Price + badges */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl font-bold tabular-nums">{displayPriceLabel}</span>
            {/* At-a-glance quote pills — matches table row format. Click the
                QuoteInspector section further down for full cascade detail. */}
            {slideoutMo?.classified_package_name && (
              <PackageBadge listingId={listing.id} name={slideoutMo.classified_package_name} />
            )}
            {slideoutMo?.resolved_tier && <TierBadge tier={slideoutMo.resolved_tier} />}
            {slideoutMo?.tier_source && <TierSourceStep tierSource={slideoutMo.tier_source} />}
            {slideoutMo?.quoted_price != null && (
              <QuoteAmount listingId={listing.id} amount={slideoutMo.quoted_price} className="text-xs" />
            )}
            {listing.listing_type && (
              <span
                className={cn(
                  "text-[11px] font-medium px-2 py-0.5 rounded-full",
                  TYPE_BADGE[listing.listing_type] || "bg-muted text-muted-foreground"
                )}
              >
                {TYPE_LABEL[listing.listing_type] || listing.listing_type}
              </span>
            )}
            {listing.price_text && (
              <span className="text-xs text-muted-foreground">{listing.price_text}</span>
            )}
          </div>

          {/* Property details */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            {listing.property_type && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Home className="h-3.5 w-3.5" />
                <span>{listing.property_type}</span>
              </div>
            )}
            {(listing.bedrooms > 0 || listing.bathrooms > 0 || listing.parking > 0) && (
              <div className="flex items-center gap-3">
                {listing.bedrooms > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <BedDouble className="h-3.5 w-3.5" />
                    {listing.bedrooms}
                  </span>
                )}
                {listing.bathrooms > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Bath className="h-3.5 w-3.5" />
                    {listing.bathrooms}
                  </span>
                )}
                {listing.parking > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Car className="h-3.5 w-3.5" />
                    {listing.parking}
                  </span>
                )}
              </div>
            )}
            {(listing.land_size_sqm > 0 || listing.land_size > 0) && (
              <div className="text-muted-foreground text-xs">
                Land: {Number(listing.land_size_sqm || listing.land_size).toLocaleString()} m²
              </div>
            )}
            {listing.date_available && listing.listing_type === "for_rent" && (
              <div className="text-muted-foreground text-xs">
                Available: {fmtDate(listing.date_available)}
              </div>
            )}
          </div>

          {/* Description */}
          {listing.description && (
            <p className="text-xs text-muted-foreground leading-relaxed border-t border-border/60 pt-3">
              {listing.description.length > 300
                ? `${listing.description.slice(0, 300)}…`
                : listing.description}
            </p>
          )}

          {/* Agent + Agency */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-border/60 pt-3">
            {/* Agent — clickable if linked pulse agent exists */}
            {linkedAgent ? (
              <button
                onClick={() => onOpenEntity?.({ type: "agent", id: linkedAgent.id })}
                className="flex items-center gap-3 text-left p-1.5 -m-1.5 rounded-md hover:bg-muted/50 transition-colors group"
                title="Open agent profile"
              >
                {listing.agent_photo ? (
                  <img
                    src={listing.agent_photo}
                    alt={listing.agent_name}
                    className="h-10 w-10 rounded-full object-cover border border-border"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center border border-border flex-shrink-0">
                    <User className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate group-hover:text-primary flex items-center gap-1">
                    {listing.agent_name || linkedAgent.full_name || "—"}
                    <ChevronRight className="h-3 w-3 opacity-40 group-hover:opacity-100" />
                  </p>
                  {listing.agent_phone && (
                    <a
                      href={`tel:${listing.agent_phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] text-muted-foreground hover:text-primary hover:underline flex items-center gap-0.5"
                    >
                      <Phone className="h-2.5 w-2.5" />
                      {listing.agent_phone}
                    </a>
                  )}
                  <p className="text-[10px] text-blue-500 mt-0.5">
                    In Pulse · click to drill in
                  </p>
                </div>
              </button>
            ) : (
              <div className="flex items-center gap-3">
                {listing.agent_photo ? (
                  <img
                    src={listing.agent_photo}
                    alt={listing.agent_name}
                    className="h-10 w-10 rounded-full object-cover border border-border"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center border border-border flex-shrink-0">
                    <User className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">
                    {listing.agent_name || "—"}
                  </p>
                  {listing.agent_phone && (
                    <a
                      href={`tel:${listing.agent_phone}`}
                      className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-0.5"
                    >
                      <Phone className="h-2.5 w-2.5" />
                      {listing.agent_phone}
                    </a>
                  )}
                  {listing.agent_name && (
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      Not yet synced — limited data
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Agency — clickable if linked */}
            {linkedAgency ? (
              <button
                onClick={() => onOpenEntity?.({ type: "agency", id: linkedAgency.id })}
                className="flex items-center gap-3 text-left p-1.5 -m-1.5 rounded-md hover:bg-muted/50 transition-colors group"
                title="Open agency profile"
              >
                {listing.agency_logo ? (
                  <img
                    src={listing.agency_logo}
                    alt={listing.agency_name}
                    className="h-8 w-auto max-w-[80px] object-contain"
                  />
                ) : (
                  <div className="h-8 w-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                    <Building2 className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate group-hover:text-primary flex items-center gap-1">
                    {listing.agency_name || linkedAgency.name || "—"}
                    <ChevronRight className="h-3 w-3 opacity-40 group-hover:opacity-100" />
                  </p>
                  <p className="text-[10px] text-blue-500 mt-0.5">
                    In Pulse · click to drill in
                  </p>
                </div>
              </button>
            ) : (
              <div className="flex items-center gap-3">
                {listing.agency_logo ? (
                  <img
                    src={listing.agency_logo}
                    alt={listing.agency_name}
                    className="h-8 w-auto max-w-[80px] object-contain"
                  />
                ) : (
                  <div className="h-8 w-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                    <Building2 className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">
                    {listing.agency_name || "—"}
                  </p>
                  {listing.agency_name && (
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      Not yet synced — limited data
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-border/60 pt-3 text-[11px]">
            {displayDate && (
              <div>
                <p className="text-muted-foreground">
                  {dateSource === "sold" ? "Sold" : "Listed"}
                  {dateSource === "derived" && (
                    <span className="text-amber-500 ml-1" title={DATE_SOURCE_LABEL.derived}>(est.)</span>
                  )}
                  {dateSource === "first_seen" && (
                    <span className="text-amber-500 ml-1" title={DATE_SOURCE_LABEL.first_seen}>(first seen)</span>
                  )}
                </p>
                <p
                  className={cn(
                    "font-medium",
                    (dateSource === "derived" || dateSource === "first_seen") && "text-muted-foreground"
                  )}
                  title={DATE_SOURCE_LABEL[dateSource] || ""}
                >
                  {fmtDate(displayDate)}
                </p>
              </div>
            )}
            {listing.listing_type === "sold" && listing.listed_date && dateSource !== "listed" && (
              <div>
                <p className="text-muted-foreground">Originally Listed</p>
                <p className="font-medium">{fmtDate(listing.listed_date)}</p>
              </div>
            )}
            {listing.days_on_market > 0 && (
              <div>
                <p className="text-muted-foreground">Days on Market</p>
                <p className="font-medium">{listing.days_on_market}d</p>
              </div>
            )}
            {listing.auction_date && (
              <div>
                <p className="text-muted-foreground">Auction</p>
                <p className="font-medium">{formatAuctionDateTime(listing.auction_date, listing.auction_time_known) || fmtDate(listing.auction_date)}</p>
              </div>
            )}
            {listing.next_inspection && (
              <div>
                <p className="text-muted-foreground">Next Inspection</p>
                <p className="font-medium">{fmtDate(listing.next_inspection)}</p>
              </div>
            )}
          </div>

          {/* Image gallery — LS09: click to open lightbox, lazy-loaded thumbs */}
          {images.length > 0 && (() => {
            const srcs = images
              .map((img) => (typeof img === "string" ? img : img?.url || img?.src))
              .filter(Boolean);
            const lightboxFiles = srcs.map((url, i) => ({
              file_name: `Photo ${i + 1}`,
              file_url: url,
              file_type: "image/jpeg",
            }));
            return (
              <div ref={galleryRef} className="border-t border-border/60 pt-3">
                <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide">
                  Gallery
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {srcs.map((src, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setLightboxIndex(i)}
                      className="block p-0 border-0 bg-transparent cursor-pointer"
                      title={`Open photo ${i + 1}`}
                    >
                      <img
                        src={src}
                        alt={`Photo ${i + 1}`}
                        loading="lazy"
                        className="h-16 w-24 object-cover rounded border border-border hover:ring-2 hover:ring-primary/50 transition"
                      />
                    </button>
                  ))}
                </div>
                {lightboxIndex !== null && (
                  <AttachmentLightbox
                    files={lightboxFiles}
                    initialIndex={lightboxIndex}
                    onClose={() => setLightboxIndex(null)}
                  />
                )}
              </div>
            );
          })()}

          {/* Floorplans — detail-enriched (migration 108+) */}
          {(() => {
            const media = parseMediaItems(listing);
            if (media.floorplans.length === 0 && !media.video) return null;
            return (
              <>
                {media.floorplans.length > 0 && (
                  <div ref={floorplansRef} className="border-t border-border/60 pt-3">
                    <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide flex items-center gap-1">
                      <FileImage className="h-3 w-3" /> Floorplans
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {media.floorplans.map((fp, i) => (
                        <a
                          key={i}
                          href={fp.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block"
                        >
                          <img
                            src={fp.thumb || fp.url}
                            alt={`Floorplan ${i + 1}`}
                            loading="lazy"
                            className="h-20 w-28 object-contain rounded border border-border bg-white hover:shadow-md transition-shadow"
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {media.video && (
                  <div className="border-t border-border/60 pt-3">
                    <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide flex items-center gap-1">
                      <Video className="h-3 w-3" /> Video
                    </p>
                    {(() => {
                      const yt = media.video.url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([A-Za-z0-9_-]{11})/);
                      if (yt) {
                        return (
                          <iframe
                            src={`https://www.youtube.com/embed/${yt[1]}`}
                            title="Listing video"
                            className="w-full aspect-video rounded border border-border"
                            frameBorder="0"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                          />
                        );
                      }
                      return (
                        <a
                          href={media.video.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                        >
                          <Video className="h-3.5 w-3.5" />
                          Watch video
                        </a>
                      );
                    })()}
                  </div>
                )}
              </>
            );
          })()}

          {/* Withdrawn banner (migration 108+) */}
          {listing.listing_withdrawn_at && (
            <div className="border-t border-border/60 pt-3">
              <div className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 rounded px-2 py-1">
                <X className="h-3 w-3" />
                Withdrawn {fmtDate(listing.listing_withdrawn_at)}
              </div>
            </div>
          )}

          {/* External link */}
          <div className="border-t border-border/60 pt-3 flex items-center gap-4 flex-wrap">
            {listing.source_url && (
              <a
                href={listing.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View on realestate.com.au
              </a>
            )}
            {listing.property_key && (
              <a
                href={`/PropertyDetails?key=${encodeURIComponent(listing.property_key)}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:underline"
              >
                <Home className="h-3.5 w-3.5" />
                Open property history
              </a>
            )}
            <button
              type="button"
              onClick={() => setSyncHistoryOpen(true)}
              className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary hover:underline"
              title="See which sync runs touched this listing"
            >
              <History className="h-3.5 w-3.5" />
              Source history
            </button>
          </div>

          <div ref={historyRef}>
            <PropertyHistoryCard
              listing={listing}
              onOpenListing={(id) => onOpenEntity?.({ type: "listing", id })}
            />
          </div>

          {listing?.id && (
            <div ref={quoteRef} className="border-t border-border/60 pt-3">
              <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                {listing.has_linked_project ? "Quote Inspector" : "Missed Opportunity Quote"}
              </p>
              <QuoteInspector
                compact
                listingId={listing.id}
                onOpenEntity={onOpenEntity}
              />
            </div>
          )}

          {/* Price/Status History */}
          {(listing.previous_asking_price || listing.previous_listing_type) && (
            <div className="mt-4 border-t pt-3">
              <h4 className="text-xs font-semibold text-muted-foreground mb-2">Changes Detected</h4>
              <div className="space-y-1.5">
                {listing.previous_asking_price && (
                  <div className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className="text-[9px]">Price Change</Badge>
                    <span className="text-muted-foreground line-through">{fmtPrice(listing.previous_asking_price)}</span>
                    <span>→</span>
                    <span className="font-medium">{fmtPrice(listing.asking_price)}</span>
                    {listing.price_changed_at && <span className="text-muted-foreground ml-auto">{fmtDate(listing.price_changed_at)}</span>}
                  </div>
                )}
                {listing.previous_listing_type && (
                  <div className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className="text-[9px]">Status Change</Badge>
                    <span className="text-muted-foreground">{listing.previous_listing_type}</span>
                    <span>→</span>
                    <span className="font-medium">{listing.listing_type}</span>
                    {listing.status_changed_at && <span className="text-muted-foreground ml-auto">{fmtDate(listing.status_changed_at)}</span>}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
      {syncHistoryOpen && (
        <EntitySyncHistoryDialog
          entityType="listing"
          entityId={listing.id}
          entityLabel={[listing.address, listing.suburb].filter(Boolean).join(", ") || "Listing"}
          onClose={() => setSyncHistoryOpen(false)}
        />
      )}
    </Dialog>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

// Columns that exist in `pulse_listings` and can be passed to PostgREST .order().
// Anything NOT in this set falls back to `created_at desc` server-side; the
// sort UI still tracks the user's intent but the list stays deterministic.
const SERVER_SORTABLE = new Set([
  "listed_date", "sold_date", "auction_date", "created_at",
  "asking_price", "sold_price", "days_on_market",
  "bedrooms", "bathrooms", "parking", "land_size",
  "listing_type", "agent_name", "agency_name", "address",
  "property_type", "price_text", "photo_count", "first_seen_at",
]);

// Safety cap on the CSV export of the FULL filtered set. 10k × ~40 columns ≈ 4MB,
// which downloads cleanly. Beyond this we'd need a streaming edge fn.
const CSV_EXPORT_CAP = 10000;

// localStorage keys — persisted across reload / tab switches.
const LS_PAGE_SIZE_KEY = "pulse_listings_page_size";
const LS_AUTO_REFRESH_KEY = "pulse_listings_auto_refresh";
const LS_EXCLUDE_WITHDRAWN_KEY = "pulse_listings_exclude_withdrawn";
const LS_FAVORITE_LISTINGS_KEY = "flex_favorite_listings";
const LS_SAVED_VIEWS_KEY = "pulse_listings_saved_views";
const LS_AGENT_WATCHLIST_KEY = "flex_agent_watchlist";
const LS_FILTER_PANEL_OPEN_KEY = "pulse_listings_filter_panel_open";

// Filter presets — kept as a single server-side combo applied on top of the
// explicit filter state. Activation is mutually-exclusive (one preset at a time).
const FILTER_PRESETS = [
  { id: "auction_this_week", label: "Auction this week", title: "Auctions scheduled within the next 7 days" },
  { id: "stale_for_sale", label: "DoM > 30 (for sale)", title: "For-sale listings with days_on_market > 30" },
  { id: "sold_over_2m", label: "Sold > $2M", title: "Sold listings above $2,000,000" },
  { id: "new_this_week", label: "New this week", title: "Listings first seen in the last 7 days" },
  { id: "with_floorplan", label: "With floorplan", title: "Listings that have floorplan URLs" },
];

const AUTO_REFRESH_INTERVAL_MS = 60_000;

// LS06: listing types where we default-hide withdrawn campaigns. Sold/UC
// listings should still be visible even if later withdrawn.
const WITHDRAWN_DEFAULT_ON_TYPES = new Set(["for_sale", "for_rent"]);

const VALID_LISTING_TYPE_PARAMS = new Set([
  "for_sale", "for_rent", "sold", "under_contract", "withdrawn",
]);

// ── LS helpers ────────────────────────────────────────────────────────────────

function readStoredPageSize() {
  if (typeof window === "undefined") return 50;
  const raw = Number(window.localStorage.getItem(LS_PAGE_SIZE_KEY));
  return PAGE_SIZE_OPTIONS.includes(raw) ? raw : 50;
}
function readStoredAutoRefresh() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LS_AUTO_REFRESH_KEY) === "1";
}
function readStoredExcludeWithdrawn() {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(LS_EXCLUDE_WITHDRAWN_KEY);
  return raw === null ? true : raw === "1";
}
function readFavoriteListings() {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(LS_FAVORITE_LISTINGS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}
function readSavedViews() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_SAVED_VIEWS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeSavedViews(views) {
  try { window.localStorage.setItem(LS_SAVED_VIEWS_KEY, JSON.stringify(views)); }
  catch { /* quota */ }
}
function readAgentWatchlist() {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(LS_AGENT_WATCHLIST_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}

// ── Utility: build a filter-state object that can be saved / restored ────────

function defaultFilterState() {
  return {
    types: [],                  // multi listing_type
    suburb: "",                 // free-text suburb / column filter
    agent: "",
    agency: "",
    agencyReaId: "",
    region: "all",
    packages: [],               // multi classified_package_name
    tiers: [],                  // multi resolved_tier (values: "standard" / "premium")
    enrichment: [],             // multi enrichment state ("fresh" | "pending" | "stale")
    quoteMin: "",               // numeric range $
    quoteMax: "",
    priceMin: "",
    priceMax: "",
    photoMin: "",
    photoMax: "",
    captured: "both",           // "yes" | "no" | "both"
    firstSeenFrom: "",
    firstSeenTo: "",
    domMin: "",
    watched: false,             // watched-only toggle
    preset: null,               // one of FILTER_PRESETS.id
  };
}

// ── Saved-view pill ───────────────────────────────────────────────────────────

function SavedViewPill({ view, active, onApply, onRename, onDelete }) {
  return (
    <div
      className={cn(
        "group inline-flex items-center gap-1 h-7 pl-2 pr-1 rounded-full border text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
      )}
    >
      <button
        type="button"
        onClick={onApply}
        className="flex items-center gap-1 max-w-[160px] truncate"
        title={`Apply view: ${view.name}`}
      >
        <Bookmark className="h-3 w-3" />
        <span className="truncate">{view.name}</span>
      </button>
      <button
        type="button"
        onClick={onRename}
        title="Rename view"
        className="opacity-0 group-hover:opacity-100 hover:bg-black/10 rounded p-0.5 transition-opacity"
      >
        <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onDelete}
        title="Delete view"
        className="opacity-0 group-hover:opacity-100 hover:bg-black/10 rounded p-0.5 transition-opacity"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

// ── Multi-select chip picker ──────────────────────────────────────────────────

function MultiChip({ label, icon: Icon, values, onChange, options, className }) {
  // Options can be either string[] or {value,label}[].
  const opts = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o
  );
  const active = values.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[11px] font-medium transition-colors",
            active
              ? "bg-primary/10 text-primary border-primary/40"
              : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground",
            className
          )}
        >
          {Icon && <Icon className="h-3 w-3" />}
          <span>{label}</span>
          {active && (
            <span className="bg-primary text-primary-foreground rounded-full px-1 text-[9px] font-semibold tabular-nums">
              {values.length}
            </span>
          )}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {opts.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={values.includes(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => {
              if (on) onChange([...values, o.value]);
              else onChange(values.filter((v) => v !== o.value));
            }}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
        {values.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-xs text-muted-foreground"
              onSelect={() => onChange([])}
            >
              <X className="h-3 w-3 mr-1" /> Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Range slider ──────────────────────────────────────────────────────────────

function RangeInput({ label, minVal, maxVal, onChange, step = 1, max, prefix = "$", className }) {
  return (
    <div className={cn("flex items-center gap-1", className)} title={label}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">{label}</span>
      <div className="relative">
        {prefix && <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">{prefix}</span>}
        <Input
          type="number"
          inputMode="numeric"
          min="0"
          max={max}
          step={step}
          placeholder="Min"
          value={minVal}
          onChange={(e) => onChange({ min: e.target.value, max: maxVal })}
          className={cn("h-7 text-xs pr-1.5 w-24", prefix ? "pl-4" : "pl-2")}
        />
      </div>
      <span className="text-[10px] text-muted-foreground">–</span>
      <div className="relative">
        {prefix && <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">{prefix}</span>}
        <Input
          type="number"
          inputMode="numeric"
          min="0"
          max={max}
          step={step}
          placeholder="Max"
          value={maxVal}
          onChange={(e) => onChange({ min: minVal, max: e.target.value })}
          className={cn("h-7 text-xs pr-1.5 w-24", prefix ? "pl-4" : "pl-2")}
        />
      </div>
    </div>
  );
}

// ── Active-filter chip ────────────────────────────────────────────────────────

function ActiveChip({ label, value, onClear }) {
  return (
    <span className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-primary/10 text-primary text-[11px] font-medium border border-primary/30">
      <span className="opacity-70">{label}:</span>
      <span className="max-w-[140px] truncate">{value}</span>
      <button onClick={onClear} className="-mr-1 ml-0.5 hover:opacity-70" title={`Clear ${label}`}>
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}

// ── Tier badge ────────────────────────────────────────────────────────────────

function TierBadge({ tier }) {
  if (!tier) return <span className="text-muted-foreground/60 text-[10px]">—</span>;
  const isPremium = tier === "premium";
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] font-semibold px-1.5 rounded uppercase",
        isPremium
          ? "bg-purple-50 text-purple-700 border border-purple-200"
          : "bg-slate-50 text-slate-700 border border-slate-200"
      )}
    >
      {isPremium ? "prm" : "std"}
    </span>
  );
}

// ── TierSourceStep ────────────────────────────────────────────────────────────
// At-a-glance pill showing WHICH cascade step produced the tier. Pairs with
// TierBadge — the tier tells you what, this tells you why. Clickable row-level
// drill into QuoteInspector happens via the parent slideout; this pill is
// purely informational (not interactive on its own).
//
// tier_source values (see QuoteInspector.TIER_SOURCE_META for full ladder):
//   matrix_agency / matrix_agent → T2 (matrix)
//   proximity_same_property      → T3a
//   proximity_same_suburb        → T3b
//   proximity_radial_{2,5,10,20,50}km → T3c + ring
//   default_std                  → T4 (fallback)
const TIER_STEP_MAP = {
  matrix_agency:           { step: "T2", ring: "matrix",  color: "emerald" },
  matrix_agent:            { step: "T2", ring: "matrix",  color: "emerald" },
  proximity_same_property: { step: "T3a", ring: "same",   color: "blue" },
  proximity_same_suburb:   { step: "T3b", ring: "suburb", color: "blue" },
  proximity_radial_2km:    { step: "T3c", ring: "2km",    color: "blue" },
  proximity_radial_5km:    { step: "T3c", ring: "5km",    color: "blue" },
  proximity_radial_10km:   { step: "T3c", ring: "10km",   color: "sky"  },
  proximity_radial_20km:   { step: "T3c", ring: "20km",   color: "sky"  },
  proximity_radial_50km:   { step: "T3c", ring: "50km",   color: "amber"},
  default_std:             { step: "T4", ring: "default", color: "amber" },
};

function TierSourceStep({ tierSource }) {
  if (!tierSource) return null;
  const meta = TIER_STEP_MAP[tierSource];
  if (!meta) {
    return (
      <span className="text-[9px] font-mono text-muted-foreground/70 px-1 rounded bg-muted/60 border border-border/40">
        {tierSource}
      </span>
    );
  }
  const colorClass = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900/40",
    blue:    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900/40",
    sky:     "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-900/40",
    amber:   "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/40",
  }[meta.color];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[9px] font-medium px-1 rounded border",
        colorClass
      )}
      title={`Tier cascade step: ${tierSource}. Open the listing to see which agency/project anchored this tier.`}
    >
      <span className="font-semibold">{meta.step}</span>
      <span className="opacity-60">·</span>
      <span>{meta.ring}</span>
    </span>
  );
}

// ── View pill group ───────────────────────────────────────────────────────────

function ViewToggle({ view, onChange }) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-background overflow-hidden">
      {VIEW_OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={cn(
            "inline-flex items-center gap-1 px-3 h-7 text-xs font-medium transition-colors",
            view === value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          )}
        >
          <Icon className="h-3 w-3" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Bulk action bar (sticky bottom) ───────────────────────────────────────────

function BulkActionBar({
  count, onClear, onForceEnrich, onWatchlistAgents, onMarkWatched, onExportSelected,
  enriching,
}) {
  if (count === 0) return null;
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-foreground text-background rounded-xl shadow-2xl flex items-center gap-1.5 pl-4 pr-2 py-2 border border-border/40"
      style={{ minWidth: 420 }}
    >
      <span className="text-xs font-semibold tabular-nums">
        {count} selected
      </span>
      <div className="h-5 w-px bg-background/20 mx-1" />
      <Button
        size="sm"
        variant="secondary"
        className="h-7 text-xs gap-1"
        onClick={onForceEnrich}
        disabled={enriching}
        title="Push selected listings to the front of the pulseDetailEnrich queue"
      >
        {enriching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
        Force enrich
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 text-xs gap-1"
        onClick={onWatchlistAgents}
        title="Add every agent in the selected rows to your local watchlist"
      >
        <User className="h-3 w-3" />
        Watchlist agents
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 text-xs gap-1"
        onClick={onMarkWatched}
        title="Mark selected listings as watched (pulse_listings.watched_at)"
      >
        <Eye className="h-3 w-3" />
        Mark watched
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 text-xs gap-1"
        onClick={onExportSelected}
      >
        <Download className="h-3 w-3" />
        CSV
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-background/70 hover:text-background hover:bg-background/10 ml-1"
        onClick={onClear}
        title="Clear selection"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── Captured indicator ────────────────────────────────────────────────────────

function CapturedDot({ captured, size = "sm" }) {
  const dim = size === "lg" ? "h-3 w-3" : "h-2 w-2";
  return (
    <span
      className={cn(
        "inline-block rounded-full",
        dim,
        captured ? "bg-emerald-500 ring-2 ring-emerald-500/30" : "bg-slate-300"
      )}
      title={captured ? "Captured by us — a project exists at this property_key" : "Not captured — no FlexStudios project at this property_key"}
    />
  );
}

// ── Grid card ─────────────────────────────────────────────────────────────────

function ListingCard({ listing, moRow, captured, selected, onToggleSelect, onOpen, favorite, onToggleFavorite }) {
  const price = sharedDisplayPrice(listing).label;
  const hero = listing.hero_image || listing.image_url;
  const quote = moRow?.quoted_price;
  const pkg = moRow?.classified_package_name;
  const tier = moRow?.resolved_tier;
  const tierSource = moRow?.tier_source;

  return (
    <div
      className={cn(
        "group relative rounded-xl border bg-card overflow-hidden flex flex-col transition-all hover:shadow-lg cursor-pointer",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border/60"
      )}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
    >
      {/* Selection checkbox (top-left) */}
      <div className="absolute top-2 left-2 z-10" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          className="bg-background shadow-sm"
        />
      </div>
      {/* Favorite (top-right) */}
      <button
        type="button"
        className="absolute top-2 right-2 z-10 p-1 rounded-full bg-background/80 backdrop-blur hover:bg-background transition"
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
        title={favorite ? "Unfavorite" : "Favorite"}
      >
        <Star className={cn("h-3.5 w-3.5", favorite ? "fill-amber-400 text-amber-500" : "text-muted-foreground")} />
      </button>

      {/* Hero */}
      <div className="relative w-full h-36 bg-muted overflow-hidden">
        {hero ? (
          <img src={hero} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="h-8 w-8 text-muted-foreground/30" />
          </div>
        )}
        {/* Type badge bottom-left */}
        {listing.listing_type && (
          <span className={cn(
            "absolute bottom-2 left-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
            TYPE_BADGE[listing.listing_type] || "bg-muted text-muted-foreground"
          )}>
            {TYPE_LABEL[listing.listing_type] || listing.listing_type}
          </span>
        )}
        {/* Captured dot bottom-right */}
        <div className="absolute bottom-2 right-2 bg-background/90 backdrop-blur rounded-full px-1.5 py-0.5 flex items-center gap-1">
          <CapturedDot captured={captured} size="sm" />
          <span className="text-[9px] font-medium uppercase text-muted-foreground">{captured ? "Won" : "Missed"}</span>
        </div>
      </div>

      {/* Body */}
      <div className="p-3 flex flex-col gap-1.5 flex-1">
        <div className="flex items-start justify-between gap-1">
          <p className="text-sm font-semibold leading-tight line-clamp-2">
            {listing.address || "—"}
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground truncate">
          {[listing.suburb, listing.postcode].filter(Boolean).join(" ") || "—"}
        </p>
        <p className="text-base font-bold tabular-nums">{price}</p>

        {/* Package + Tier + Quote */}
        <div className="flex items-center flex-wrap gap-1.5 pt-1 border-t border-border/50">
          {pkg ? (
            <PackageBadge listingId={listing.id} name={pkg} />
          ) : (
            <span className="text-[10px] text-muted-foreground">No quote</span>
          )}
          {tier && <TierBadge tier={tier} />}
          {tierSource && <TierSourceStep tierSource={tierSource} />}
          {quote ? (
            <QuoteAmount listingId={listing.id} amount={quote} className="text-xs ml-auto" />
          ) : null}
        </div>

        {/* Agent + Agency row */}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 gap-2">
          <span className="truncate flex-1 min-w-0" title={listing.agent_name || ""}>
            {listing.agent_name || "—"}
          </span>
          <EnrichmentBadge listing={listing} compact />
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-muted-foreground truncate" title={listing.agency_name || ""}>
            {listing.agency_name || "—"}
          </span>
          {listing.source_url && (
            <a
              href={listing.source_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="Open on REA"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PulseListingsTab({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  crmAgents = [],
  targetSuburbs = [],
  search = "",
  onOpenEntity,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const suburbParam = searchParams.get("suburb");
  const agencyReaIdParam = searchParams.get("agency_rea_id");
  const typeParam = searchParams.get("type");
  const viewParam = searchParams.get("listings_view");

  // ─── View toggle (table | grid | map) ──
  const [view, setView] = useState(() =>
    viewParam && ["table", "grid", "map"].includes(viewParam) ? viewParam : "table"
  );
  useEffect(() => {
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (view === "table") np.delete("listings_view");
      else np.set("listings_view", view);
      return np;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ─── Filter state (unified object) ──
  const [filters, setFilters] = useState(() => {
    const base = defaultFilterState();
    if (typeParam && VALID_LISTING_TYPE_PARAMS.has(typeParam)) {
      base.types = [typeParam];
    } else {
      // Default: show every type (empty array = no filter).
    }
    if (suburbParam) base.suburb = suburbParam;
    if (agencyReaIdParam) base.agencyReaId = agencyReaIdParam;
    return base;
  });

  // Consume one-shot URL params so back/forward doesn't re-fire.
  useEffect(() => {
    if (!suburbParam && !agencyReaIdParam && !typeParam) return;
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      np.delete("suburb");
      np.delete("agency_rea_id");
      np.delete("type");
      return np;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suburbParam, agencyReaIdParam, typeParam]);

  const updateFilter = useCallback((patch) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);
  const clearFilters = useCallback(() => {
    setFilters(defaultFilterState());
  }, []);

  const [listingSort, setListingSort] = useState({ col: "listed_date", dir: "desc" });
  const [listingPage, setListingPage] = useState(0);
  const [pageSize, setPageSize] = useState(readStoredPageSize);

  // Sticky state
  const [autoRefresh, setAutoRefresh] = useState(readStoredAutoRefresh);
  const [excludeWithdrawn, setExcludeWithdrawn] = useState(readStoredExcludeWithdrawn);
  const [favorites, setFavorites] = useState(readFavoriteListings);
  const [agentWatchlist, setAgentWatchlist] = useState(readAgentWatchlist);
  const [savedViews, setSavedViews] = useState(readSavedViews);
  const [activeViewId, setActiveViewId] = useState(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(LS_FILTER_PANEL_OPEN_KEY) === "1";
  });

  // Selection + UI
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedListing, setSelectedListing] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [focusedRowIdx, setFocusedRowIdx] = useState(-1);

  // ─── LS persistence ──
  useEffect(() => {
    try { window.localStorage.setItem(LS_PAGE_SIZE_KEY, String(pageSize)); } catch { /* quota */ }
  }, [pageSize]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_AUTO_REFRESH_KEY, autoRefresh ? "1" : "0"); } catch { /* quota */ }
  }, [autoRefresh]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_EXCLUDE_WITHDRAWN_KEY, excludeWithdrawn ? "1" : "0"); } catch { /* quota */ }
  }, [excludeWithdrawn]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_FAVORITE_LISTINGS_KEY, JSON.stringify(Array.from(favorites))); } catch { /* quota */ }
  }, [favorites]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_AGENT_WATCHLIST_KEY, JSON.stringify(Array.from(agentWatchlist))); } catch { /* quota */ }
  }, [agentWatchlist]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_FILTER_PANEL_OPEN_KEY, filterPanelOpen ? "1" : "0"); } catch { /* quota */ }
  }, [filterPanelOpen]);

  // ─── Region derivations ──
  const regions = useMemo(() => {
    const set = new Set();
    for (const s of targetSuburbs || []) {
      if (s?.region) set.add(s.region);
    }
    return Array.from(set).sort();
  }, [targetSuburbs]);
  const suburbsInRegion = useMemo(() => {
    if (filters.region === "all") return null;
    return (targetSuburbs || [])
      .filter((s) => s?.region === filters.region && s?.name)
      .map((s) => s.name);
  }, [targetSuburbs, filters.region]);

  // Reset to page 0 when filters change.
  useEffect(() => { setListingPage(0); }, [filters, pageSize, search, listingSort.col, listingSort.dir, excludeWithdrawn]);
  // Clear selection when the window shifts.
  useEffect(() => { setSelectedIds(new Set()); }, [filters, pageSize, search, listingSort.col, listingSort.dir, excludeWithdrawn, listingPage]);

  // ─── Favorites ──
  const toggleFavorite = useCallback((id) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); toast.success("Removed from favorites"); }
      else { next.add(id); toast.success("Added to favorites"); }
      return next;
    });
  }, []);

  const copyText = useCallback((text, label) => {
    if (!text) return;
    try { navigator.clipboard.writeText(text); toast.success(`${label} copied`); }
    catch { toast.error("Copy failed"); }
  }, []);

  // ─── Sort ──
  const handleSort = useCallback((col) => {
    setListingSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: "desc" }
    );
    setListingPage(0);
  }, []);

  // ─── Suggestion data (distinct suburbs / agents from props) ──
  const distinctSuburbs = useMemo(() => {
    // Prefer targetSuburbs (curated) — fall back to suburbs present in pulseListings.
    if (Array.isArray(targetSuburbs) && targetSuburbs.length > 0) {
      return targetSuburbs.map((s) => s?.name).filter(Boolean);
    }
    return Array.from(new Set((pulseListings || []).map((l) => l.suburb).filter(Boolean))).sort();
  }, [targetSuburbs, pulseListings]);
  const distinctAgents = useMemo(() =>
    (pulseAgents || []).map((a) => a.full_name).filter(Boolean).sort(),
    [pulseAgents]);
  const distinctAgencies = useMemo(() =>
    (pulseAgencies || []).map((a) => a.name).filter(Boolean).sort(),
    [pulseAgencies]);

  // ─── Pre-fetch the list of listing_ids flagged by the missed-opportunity
  //     filters (packages, tiers, enrichment). PostgREST can't join across
  //     tables in a single request, so we resolve to an id-set first then
  //     feed it in via .in('id', [...]) on the listings query. When no MO
  //     filters are active we skip this round-trip entirely.
  const needsMoLookup = filters.packages.length > 0
    || filters.tiers.length > 0
    || filters.enrichment.length > 0
    || filters.quoteMin !== ""
    || filters.quoteMax !== "";
  const moFilterIdsKey = useMemo(() => [
    "mo-filter-ids",
    { pkgs: [...filters.packages].sort(), tiers: [...filters.tiers].sort(), enr: [...filters.enrichment].sort(), qMin: filters.quoteMin, qMax: filters.quoteMax },
  ], [filters.packages, filters.tiers, filters.enrichment, filters.quoteMin, filters.quoteMax]);

  const { data: moFilterIds } = useQuery({
    queryKey: moFilterIdsKey,
    queryFn: async () => {
      if (!needsMoLookup) return null;
      // Package filter: "UNCLASSIFIABLE" maps to classified_package_name IS NULL.
      // We fetch in pages (PostgREST default cap 1000). To keep it fast we cap
      // at 20k ids — far more than the user can page through interactively.
      const CAP = 20_000;
      const collectedIds = [];
      const fetchChunk = async (from, to) => {
        let q = api._supabase
          .from("pulse_listing_missed_opportunity")
          .select("listing_id")
          .range(from, to);
        if (filters.packages.length > 0) {
          const hasUnclass = filters.packages.includes("UNCLASSIFIABLE");
          const named = filters.packages.filter((p) => p !== "UNCLASSIFIABLE");
          if (hasUnclass && named.length === 0) {
            q = q.is("classified_package_name", null);
          } else if (!hasUnclass && named.length > 0) {
            q = q.in("classified_package_name", named);
          } else {
            // both branches — classified IN (...) OR IS NULL
            const nameList = named.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
            q = q.or(`classified_package_name.is.null,classified_package_name.in.(${nameList})`);
          }
        }
        if (filters.tiers.length > 0) q = q.in("resolved_tier", filters.tiers);
        if (filters.quoteMin) {
          const n = Number(filters.quoteMin);
          if (Number.isFinite(n)) q = q.gte("quoted_price", n);
        }
        if (filters.quoteMax) {
          const n = Number(filters.quoteMax);
          if (Number.isFinite(n)) q = q.lte("quoted_price", n);
        }
        return q;
      };
      for (let off = 0; off < CAP; off += 1000) {
        const end = Math.min(off + 999, CAP - 1);
        const { data: chunk, error } = await fetchChunk(off, end);
        if (error) throw error;
        if (!chunk || chunk.length === 0) break;
        for (const row of chunk) collectedIds.push(row.listing_id);
        if (chunk.length < 1000) break;
      }
      return collectedIds;
    },
    enabled: needsMoLookup,
    staleTime: 30_000,
    keepPreviousData: true,
  });

  // Enrichment filter doesn't live in the MO substrate (it's derived from
  // `pulse_listings.detail_enriched_at`). Apply it as a second-stage filter
  // on the base pulse_listings query below.

  // ─── Main query builder (base pulse_listings) ──
  const buildQuery = useCallback((baseSelect, withCount) => {
    let q = api._supabase
      .from("pulse_listings")
      .select(baseSelect, withCount ? { count: "exact" } : undefined);

    // Type filter (multi)
    if (filters.types.length === 1) {
      q = q.eq("listing_type", filters.types[0]);
    } else if (filters.types.length > 1) {
      q = q.in("listing_type", filters.types);
    }

    // Agency filter by REA id
    if (filters.agencyReaId) {
      q = q.eq("agency_rea_id", filters.agencyReaId);
    }

    // Free-text agency
    if (filters.agency && !filters.agencyReaId) {
      const s = filters.agency.replace(/[%_]/g, "\\$&");
      q = q.ilike("agency_name", `%${s}%`);
    }
    // Free-text agent
    if (filters.agent) {
      const s = filters.agent.replace(/[%_]/g, "\\$&");
      q = q.ilike("agent_name", `%${s}%`);
    }
    // Free-text suburb
    if (filters.suburb) {
      const s = filters.suburb.replace(/[%_]/g, "\\$&");
      q = q.ilike("suburb", `%${s}%`);
    }

    // Region — expands to suburb IN (...)
    if (suburbsInRegion) {
      if (suburbsInRegion.length === 0) {
        q = q.eq("id", "00000000-0000-0000-0000-000000000000");
      } else {
        q = q.in("suburb", suburbsInRegion);
      }
    }

    // Exclude withdrawn — only when the filter makes sense.
    const typesAllowWithdrawnToggle = filters.types.length === 0
      || filters.types.every((t) => WITHDRAWN_DEFAULT_ON_TYPES.has(t));
    if (excludeWithdrawn && typesAllowWithdrawnToggle) {
      q = q.is("listing_withdrawn_at", null);
    }

    // Global search (via the trigger-maintained search_text column).
    const globalQ = (search || "").trim();
    if (globalQ) {
      const s = globalQ.toLowerCase().replace(/[%_]/g, "\\$&");
      const normalized = globalQ
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[-,]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[%_]/g, "\\$&");
      q = q.or(`search_text.ilike.%${s}%,property_key.ilike.%${normalized}%`);
    }

    // Asking price range.
    const parseNum = (v) => {
      if (v === "" || v == null) return null;
      const n = Number(String(v).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const minP = parseNum(filters.priceMin);
    const maxP = parseNum(filters.priceMax);
    if (minP != null && maxP != null) {
      q = q.or(
        `and(asking_price.gte.${minP},asking_price.lte.${maxP}),` +
        `and(asking_price.is.null,sold_price.gte.${minP},sold_price.lte.${maxP})`
      );
    } else if (minP != null) {
      q = q.or(`asking_price.gte.${minP},and(asking_price.is.null,sold_price.gte.${minP})`);
    } else if (maxP != null) {
      q = q.or(`asking_price.lte.${maxP},and(asking_price.is.null,sold_price.lte.${maxP})`);
    }

    // Photos range.
    const photoMin = parseNum(filters.photoMin);
    const photoMax = parseNum(filters.photoMax);
    if (photoMin != null) q = q.gte("photo_count", photoMin);
    if (photoMax != null) q = q.lte("photo_count", photoMax);

    // DoM minimum.
    const minDom = parseNum(filters.domMin);
    if (minDom != null) q = q.gte("days_on_market", minDom);

    // First-seen range.
    if (filters.firstSeenFrom) {
      q = q.gte("first_seen_at", filters.firstSeenFrom);
    }
    if (filters.firstSeenTo) {
      // Inclusive end-of-day.
      q = q.lte("first_seen_at", `${filters.firstSeenTo}T23:59:59.999Z`);
    }

    // Watched only.
    if (filters.watched) {
      q = q.not("watched_at", "is", null);
    }

    // Enrichment state (derived from detail_enriched_at).
    if (filters.enrichment.length > 0) {
      const now = Date.now();
      const staleCutoffIso = new Date(now - 14 * 86400000).toISOString();
      const wantFresh = filters.enrichment.includes("fresh");
      const wantPending = filters.enrichment.includes("pending");
      const wantStale = filters.enrichment.includes("stale");
      const ors = [];
      if (wantPending) ors.push("detail_enriched_at.is.null");
      if (wantFresh) ors.push(`detail_enriched_at.gte.${staleCutoffIso}`);
      if (wantStale) ors.push(`and(detail_enriched_at.not.is.null,detail_enriched_at.lt.${staleCutoffIso})`);
      if (ors.length > 0) q = q.or(ors.join(","));
    }

    // Filter by MO-lookup id set if any MO-based filter is active.
    if (needsMoLookup) {
      const ids = moFilterIds || [];
      if (ids.length === 0) {
        // No rows match the MO filter yet; force empty result.
        q = q.eq("id", "00000000-0000-0000-0000-000000000000");
      } else {
        // PostgREST caps `in` at a generous size; 20k should pass in one URL
        // (chunked would require OR-of-ins which is supported too).
        q = q.in("id", ids);
      }
    }

    // Preset layer.
    if (filters.preset === "auction_this_week") {
      const now = new Date().toISOString();
      const in7 = new Date(Date.now() + 7 * 86400000).toISOString();
      q = q.not("auction_date", "is", null).gte("auction_date", now).lte("auction_date", in7);
    } else if (filters.preset === "stale_for_sale") {
      q = q.eq("listing_type", "for_sale").gt("days_on_market", 30);
    } else if (filters.preset === "sold_over_2m") {
      q = q.eq("listing_type", "sold").gt("sold_price", 2_000_000);
    } else if (filters.preset === "new_this_week") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      q = q.gt("first_seen_at", sevenDaysAgo);
    } else if (filters.preset === "with_floorplan") {
      q = q.not("floorplan_urls", "is", null);
    }

    // Sort (falls back to created_at desc for un-sortable columns).
    const sortCol = SERVER_SORTABLE.has(listingSort.col) ? listingSort.col : "created_at";
    q = q.order(sortCol, { ascending: listingSort.dir === "asc", nullsFirst: false });

    return q;
  }, [filters, search, listingSort, excludeWithdrawn, suburbsInRegion, needsMoLookup, moFilterIds]);

  // ─── Page fetch ──
  // For Map view we want ALL rows (with coords) in the filtered window — but
  // only when the user is on the Map tab. Otherwise we fetch a page worth.
  const mapMode = view === "map";
  const queryKey = useMemo(
    () => ["pulse-listings-page", {
      filters, search, sortCol: listingSort.col, sortDir: listingSort.dir,
      page: listingPage, pageSize, excludeWithdrawn, mapMode,
      moFilterIdsHash: moFilterIds ? moFilterIds.length : "n/a",
    }],
    [filters, search, listingSort, listingPage, pageSize, excludeWithdrawn, mapMode, moFilterIds],
  );

  const { data, isLoading, isFetching } = useQuery({
    queryKey,
    queryFn: async () => {
      if (mapMode) {
        // Cap map to first 2000 rows that have coords — more than enough to
        // visualise, and bounded to keep the payload small.
        const q = buildQuery("id,address,suburb,postcode,listing_type,asking_price,sold_price,price_text,photo_count,hero_image,image_url,latitude,longitude,property_key,agent_name,agency_name,source_url,detail_enriched_at,days_on_market,first_seen_at", true)
          .not("latitude", "is", null).not("longitude", "is", null)
          .range(0, 1999);
        const { data: rows, count, error } = await q;
        if (error) throw error;
        return { rows: rows || [], count: count || 0 };
      }
      const from = listingPage * pageSize;
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
    enabled: needsMoLookup ? Array.isArray(moFilterIds) : true,
  });

  const rows = data?.rows || [];
  const total = data?.count || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // ─── Side-fetch: join MO substrate for just the visible rows ──
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const { data: moByListingId } = useQuery({
    queryKey: ["pulse-mo-for-rows", visibleIds.slice().sort().join(",")],
    queryFn: async () => {
      if (visibleIds.length === 0) return {};
      const { data: mo, error } = await api._supabase
        .from("pulse_listing_missed_opportunity")
        .select("listing_id,classified_package_name,resolved_tier,quoted_price,quote_status,tier_source")
        .in("listing_id", visibleIds);
      if (error) throw error;
      const map = {};
      for (const r of mo || []) map[r.listing_id] = r;
      return map;
    },
    enabled: visibleIds.length > 0,
    staleTime: 60_000,
  });

  // ─── Side-fetch: captured-by-us lookup (which rows have a project?) ──
  const visiblePropertyKeys = useMemo(
    () => Array.from(new Set(rows.map((r) => r.property_key).filter(Boolean))),
    [rows]
  );
  const { data: capturedSet } = useQuery({
    queryKey: ["pulse-captured-projects", visiblePropertyKeys.slice().sort().join(",")],
    queryFn: async () => {
      if (visiblePropertyKeys.length === 0) return new Set();
      const { data: prj, error } = await api._supabase
        .from("projects")
        .select("property_key")
        .in("property_key", visiblePropertyKeys);
      if (error) throw error;
      return new Set((prj || []).map((p) => p.property_key));
    },
    enabled: visiblePropertyKeys.length > 0,
    staleTime: 60_000,
  });

  // ─── CSV export (full filtered set) ──
  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const headQ = buildQuery("id", true).limit(1);
      const { count: totalCount, error: countErr } = await headQ;
      if (countErr) throw countErr;
      const cap = Math.min(totalCount || 0, CSV_EXPORT_CAP);
      if ((totalCount || 0) > CSV_EXPORT_CAP) {
        const ok = window.confirm(
          `Your filter matches ${totalCount.toLocaleString()} listings. ` +
          `Only the first ${CSV_EXPORT_CAP.toLocaleString()} will export. Continue?`,
        );
        if (!ok) { setExporting(false); return; }
      }
      const all = [];
      for (let off = 0; off < cap; off += 1000) {
        const end = Math.min(off + 999, cap - 1);
        const q = buildQuery("*", false).range(off, end);
        const { data: chunk, error } = await q;
        if (error) throw error;
        all.push(...(chunk || []));
        if (!chunk || chunk.length < 1000) break;
      }
      const header = [
        "address", "suburb", "postcode", "listing_type", "asking_price", "sold_price",
        "bedrooms", "bathrooms", "parking", "land_size", "days_on_market",
        "agent_name", "agency_name", "listed_date", "sold_date",
        "auction_date", "auction_time_known", "listing_withdrawn_at", "first_seen_at",
        "floorplan_urls", "video_url",
        "property_key", "source_url", "last_synced_at",
      ];
      const flatRows = all.map((r) => ({
        ...r,
        floorplan_urls: Array.isArray(r.floorplan_urls) ? r.floorplan_urls.join(" | ") : (r.floorplan_urls ?? ""),
      }));
      exportCsv(`pulse_listings_${new Date().toISOString().slice(0, 10)}.csv`, header, flatRows);
    } catch (err) {
      window.alert(`CSV export failed: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  }, [buildQuery]);

  const handleExportSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const picked = (rows || []).filter((r) => selectedIds.has(r.id));
    if (picked.length === 0) return;
    const header = [
      "address", "suburb", "postcode", "listing_type", "asking_price", "sold_price",
      "bedrooms", "bathrooms", "parking", "land_size", "days_on_market",
      "agent_name", "agency_name", "listed_date", "sold_date",
      "auction_date", "auction_time_known", "listing_withdrawn_at", "first_seen_at",
      "floorplan_urls", "video_url",
      "property_key", "source_url", "last_synced_at",
    ];
    const flat = picked.map((r) => ({
      ...r,
      floorplan_urls: Array.isArray(r.floorplan_urls) ? r.floorplan_urls.join(" | ") : (r.floorplan_urls ?? ""),
    }));
    exportCsv(`pulse_listings_selected_${new Date().toISOString().slice(0, 10)}.csv`, header, flat);
  }, [selectedIds, rows]);

  // ─── Bulk actions ──
  const handleForceEnrich = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setEnriching(true);
    try {
      const res = await api.functions.invoke("pulseDetailEnrich", {
        trigger: "manual_force",
        priority_mode: "auto",
        force_ids: ids,
        max_listings: Math.min(1000, ids.length),
      });
      // api.functions.invoke throws on transport/HTTP errors; soft errors come
      // back inside the response body, which is under `.data`. Check both so a
      // server-reported error isn't silently treated as success.
      const body = res?.data ?? res;
      const softError = body?.error;
      if (!softError) {
        toast.success(`Force-enrich queued for ${ids.length} listing${ids.length === 1 ? "" : "s"}`);
      } else {
        throw new Error(typeof softError === 'string' ? softError : softError?.message || "Enrichment trigger failed");
      }
    } catch (err) {
      toast.error(`Force-enrich failed: ${err?.message || err}`);
    } finally {
      setEnriching(false);
    }
  }, [selectedIds]);

  const handleWatchlistAgents = useCallback(() => {
    const picked = rows.filter((r) => selectedIds.has(r.id));
    const toAdd = new Set();
    for (const r of picked) {
      const agentId = r.agent_pulse_id
        || pulseAgents.find((a) => a.rea_agent_id === r.agent_rea_id)?.id;
      if (agentId) toAdd.add(agentId);
    }
    if (toAdd.size === 0) { toast.info("No resolvable agents in selection"); return; }
    setAgentWatchlist((prev) => {
      const next = new Set(prev);
      for (const id of toAdd) next.add(id);
      return next;
    });
    toast.success(`Added ${toAdd.size} agent${toAdd.size === 1 ? "" : "s"} to watchlist`);
  }, [rows, selectedIds, pulseAgents]);

  const handleMarkWatched = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      const { error } = await api._supabase
        .from("pulse_listings")
        .update({ watched_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
      toast.success(`Marked ${ids.length} listing${ids.length === 1 ? "" : "s"} as watched`);
    } catch (err) {
      toast.error(`Mark watched failed: ${err?.message || err}`);
    }
  }, [selectedIds]);

  // ─── Selection helpers ──
  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0 && !allSelected;
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }, [allSelected, pageIds]);

  const toggleSelectOne = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ─── Active filter chips ──
  const activeChips = useMemo(() => {
    const out = [];
    if (filters.types.length > 0) out.push({ k: "types", label: "Type", value: filters.types.map((t) => TYPE_LABEL[t] || t).join(", "), clear: () => updateFilter({ types: [] }) });
    if (filters.suburb) out.push({ k: "suburb", label: "Suburb", value: filters.suburb, clear: () => updateFilter({ suburb: "" }) });
    if (filters.agent) out.push({ k: "agent", label: "Agent", value: filters.agent, clear: () => updateFilter({ agent: "" }) });
    if (filters.agency) out.push({ k: "agency", label: "Agency", value: filters.agency, clear: () => updateFilter({ agency: "" }) });
    if (filters.agencyReaId) {
      const name = (pulseAgencies || []).find((a) => String(a.rea_agency_id) === String(filters.agencyReaId))?.name || `REA ${filters.agencyReaId}`;
      out.push({ k: "agencyRea", label: "Agency", value: name, clear: () => updateFilter({ agencyReaId: "" }) });
    }
    if (filters.region !== "all") out.push({ k: "region", label: "Region", value: filters.region, clear: () => updateFilter({ region: "all" }) });
    if (filters.packages.length > 0) out.push({ k: "packages", label: "Package", value: filters.packages.join(", "), clear: () => updateFilter({ packages: [] }) });
    if (filters.tiers.length > 0) out.push({ k: "tiers", label: "Tier", value: filters.tiers.join(", "), clear: () => updateFilter({ tiers: [] }) });
    if (filters.enrichment.length > 0) out.push({ k: "enrichment", label: "Enrichment", value: filters.enrichment.join(", "), clear: () => updateFilter({ enrichment: [] }) });
    if (filters.quoteMin || filters.quoteMax) out.push({ k: "quote", label: "Quote", value: `$${filters.quoteMin || 0}–${filters.quoteMax || "∞"}`, clear: () => updateFilter({ quoteMin: "", quoteMax: "" }) });
    if (filters.priceMin || filters.priceMax) out.push({ k: "price", label: "Price", value: `$${filters.priceMin || 0}–${filters.priceMax || "∞"}`, clear: () => updateFilter({ priceMin: "", priceMax: "" }) });
    if (filters.photoMin || filters.photoMax) out.push({ k: "photos", label: "Photos", value: `${filters.photoMin || 0}–${filters.photoMax || "∞"}`, clear: () => updateFilter({ photoMin: "", photoMax: "" }) });
    if (filters.captured !== "both") out.push({ k: "captured", label: "Captured", value: filters.captured, clear: () => updateFilter({ captured: "both" }) });
    if (filters.firstSeenFrom || filters.firstSeenTo) out.push({ k: "firstSeen", label: "First seen", value: `${filters.firstSeenFrom || "…"} → ${filters.firstSeenTo || "…"}`, clear: () => updateFilter({ firstSeenFrom: "", firstSeenTo: "" }) });
    if (filters.domMin) out.push({ k: "dom", label: "DoM ≥", value: filters.domMin, clear: () => updateFilter({ domMin: "" }) });
    if (filters.watched) out.push({ k: "watched", label: "Watched", value: "yes", clear: () => updateFilter({ watched: false }) });
    if (filters.preset) {
      const p = FILTER_PRESETS.find((pp) => pp.id === filters.preset);
      out.push({ k: "preset", label: "Preset", value: p?.label || filters.preset, clear: () => updateFilter({ preset: null }) });
    }
    return out;
  }, [filters, pulseAgencies, updateFilter]);

  const filterCount = activeChips.length;

  // Captured post-filter (second stage, client side, within the visible page).
  const filteredRows = useMemo(() => {
    if (filters.captured === "both") return rows;
    return rows.filter((r) => {
      const isCaptured = capturedSet ? capturedSet.has(r.property_key) : false;
      return filters.captured === "yes" ? isCaptured : !isCaptured;
    });
  }, [rows, capturedSet, filters.captured]);

  // ─── Saved views ──
  const applySavedView = useCallback((sv) => {
    setFilters({ ...defaultFilterState(), ...sv.filters });
    setActiveViewId(sv.id);
    toast.success(`Applied view: ${sv.name}`);
  }, []);
  const handleSaveView = useCallback(() => {
    const name = window.prompt("Name for this view?", "My view");
    if (!name) return;
    const next = [...savedViews, { id: crypto.randomUUID(), name, filters }];
    setSavedViews(next);
    writeSavedViews(next);
    toast.success(`Saved view: ${name}`);
  }, [savedViews, filters]);
  const handleRenameView = useCallback((sv) => {
    const name = window.prompt("New name?", sv.name);
    if (!name) return;
    const next = savedViews.map((v) => v.id === sv.id ? { ...v, name } : v);
    setSavedViews(next);
    writeSavedViews(next);
  }, [savedViews]);
  const handleDeleteView = useCallback((sv) => {
    if (!window.confirm(`Delete view "${sv.name}"?`)) return;
    const next = savedViews.filter((v) => v.id !== sv.id);
    setSavedViews(next);
    writeSavedViews(next);
    if (activeViewId === sv.id) setActiveViewId(null);
    toast.success("View deleted");
  }, [savedViews, activeViewId]);

  // ─── Keyboard nav (j/k = row, h/l = page) ──
  useEffect(() => {
    const onKey = (e) => {
      // Ignore when typing in inputs
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (view !== "table") return;
      if (e.key === "j") {
        setFocusedRowIdx((i) => Math.min(filteredRows.length - 1, i + 1));
      } else if (e.key === "k") {
        setFocusedRowIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "h") {
        setListingPage((p) => Math.max(0, p - 1));
      } else if (e.key === "l") {
        setListingPage((p) => Math.min(totalPages - 1, p + 1));
      } else if (e.key === "Enter" && focusedRowIdx >= 0 && focusedRowIdx < filteredRows.length) {
        const row = filteredRows[focusedRowIdx];
        if (row && onOpenEntity) onOpenEntity({ type: "listing", id: row.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, filteredRows, totalPages, focusedRowIdx, onOpenEntity]);

  const openListing = useCallback((l) => {
    if (onOpenEntity) onOpenEntity({ type: "listing", id: l.id });
    else setSelectedListing(l);
  }, [onOpenEntity]);

  // ─── Th (sortable header) ──
  const Th = ({ col, children, className }) => (
    <th
      className={cn(
        "px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none whitespace-nowrap hover:text-foreground transition-colors",
        className
      )}
      onClick={col ? () => handleSort(col) : undefined}
      style={{ cursor: col ? "pointer" : "default" }}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {col && <SortIcon col={col} sort={listingSort} />}
      </span>
    </th>
  );

  // ─── Render ──
  return (
    <div className="space-y-3">
      {/* TOP bar: view toggle + filter panel toggle + saved views */}
      <div className="flex flex-wrap items-center gap-2">
        <ViewToggle view={view} onChange={setView} />

        <button
          type="button"
          onClick={() => setFilterPanelOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors",
            filterPanelOpen
              ? "bg-primary/10 text-primary border-primary/40"
              : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
          )}
        >
          <Filter className="h-3 w-3" />
          <span>Filters</span>
          {filterCount > 0 && (
            <span className="bg-primary text-primary-foreground rounded-full px-1 text-[9px] font-semibold tabular-nums">
              {filterCount}
            </span>
          )}
          <ChevronDown className={cn("h-3 w-3 transition-transform", filterPanelOpen && "rotate-180")} />
        </button>

        {/* Saved views pill row */}
        <div className="flex items-center gap-1 flex-wrap">
          {savedViews.map((sv) => (
            <SavedViewPill
              key={sv.id}
              view={sv}
              active={activeViewId === sv.id}
              onApply={() => applySavedView(sv)}
              onRename={() => handleRenameView(sv)}
              onDelete={() => handleDeleteView(sv)}
            />
          ))}
          <button
            type="button"
            onClick={handleSaveView}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-full border border-dashed border-border text-[11px] text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
            title="Save current filters as a view"
          >
            <Save className="h-3 w-3" />
            Save view
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Auto-refresh */}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none" title="Auto-refresh every 60s">
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} aria-label="Auto-refresh every 60s" />
            <span>Auto-refresh</span>
          </label>
          {/* Exclude withdrawn */}
          <label className={cn(
            "flex items-center gap-1.5 text-[11px] cursor-pointer select-none",
            (filters.types.length === 0 || filters.types.every((t) => WITHDRAWN_DEFAULT_ON_TYPES.has(t)))
              ? "text-muted-foreground"
              : "text-muted-foreground/50 cursor-not-allowed"
          )} title="Hide listings flagged as withdrawn on REA">
            <Switch
              checked={excludeWithdrawn}
              onCheckedChange={setExcludeWithdrawn}
              disabled={!(filters.types.length === 0 || filters.types.every((t) => WITHDRAWN_DEFAULT_ON_TYPES.has(t)))}
            />
            <span>Exclude withdrawn</span>
          </label>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1" onClick={handleExportCsv} disabled={total === 0 || exporting}>
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            CSV
          </Button>
        </div>
      </div>

      {/* Quick Type pills (mini nav) — mirrors previous top row */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">Type</span>
        {TYPE_FILTERS.map(({ value, label, tooltip }) => {
          const isOn = filters.types.includes(value);
          return (
            <button
              key={value}
              onClick={() => {
                updateFilter({ types: isOn ? filters.types.filter((t) => t !== value) : [...filters.types, value] });
              }}
              title={tooltip}
              className={cn(
                "text-[11px] px-2 py-0.5 rounded-md border font-medium transition-colors",
                isOn
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
              )}
            >
              {label}
            </button>
          );
        })}

        <span className="mx-1 text-muted-foreground/50">·</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">Presets</span>
        {FILTER_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => updateFilter({ preset: filters.preset === p.id ? null : p.id })}
            title={p.title}
            className={cn(
              "text-[11px] px-2 py-0.5 rounded-full border font-medium transition-colors",
              filters.preset === p.id
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Advanced filter panel (collapsible) */}
      {filterPanelOpen && (
        <div className="rounded-xl border border-border/60 bg-card p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Suburb autocomplete */}
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Suburb</span>
              <input
                list="pulse-listings-suburb-list"
                value={filters.suburb}
                onChange={(e) => updateFilter({ suburb: e.target.value })}
                placeholder="Any"
                className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring w-40"
              />
              <datalist id="pulse-listings-suburb-list">
                {distinctSuburbs.slice(0, 300).map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            {/* Agent autocomplete */}
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Agent</span>
              <input
                list="pulse-listings-agent-list"
                value={filters.agent}
                onChange={(e) => updateFilter({ agent: e.target.value })}
                placeholder="Any"
                className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring w-40"
              />
              <datalist id="pulse-listings-agent-list">
                {distinctAgents.slice(0, 300).map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            {/* Agency autocomplete */}
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Agency</span>
              <input
                list="pulse-listings-agency-list"
                value={filters.agency}
                onChange={(e) => updateFilter({ agency: e.target.value })}
                placeholder="Any"
                className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring w-44"
              />
              <datalist id="pulse-listings-agency-list">
                {distinctAgencies.slice(0, 300).map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            {/* Region */}
            {regions.length > 0 && (
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Region</span>
                <select
                  value={filters.region}
                  onChange={(e) => updateFilter({ region: e.target.value })}
                  className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="all">All regions</option>
                  {regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            )}

            <div className="mx-1 h-8 w-px bg-border" />

            <MultiChip
              label="Package"
              icon={Sparkles}
              values={filters.packages}
              onChange={(v) => updateFilter({ packages: v })}
              options={PACKAGE_OPTIONS}
            />
            <MultiChip
              label="Tier"
              values={filters.tiers}
              onChange={(v) => updateFilter({ tiers: v })}
              options={TIER_OPTIONS}
            />
            <MultiChip
              label="Enrichment"
              values={filters.enrichment}
              onChange={(v) => updateFilter({ enrichment: v })}
              options={ENRICHMENT_OPTIONS}
            />

            <div className="mx-1 h-8 w-px bg-border" />

            <RangeInput
              label="Quote $"
              minVal={filters.quoteMin}
              maxVal={filters.quoteMax}
              onChange={({ min, max }) => updateFilter({ quoteMin: min, quoteMax: max })}
              step={100}
              max={10000}
              prefix="$"
            />
            <RangeInput
              label="Ask $"
              minVal={filters.priceMin}
              maxVal={filters.priceMax}
              onChange={({ min, max }) => updateFilter({ priceMin: min, priceMax: max })}
              step={10000}
              max={20_000_000}
              prefix="$"
            />
            <RangeInput
              label="Photos"
              minVal={filters.photoMin}
              maxVal={filters.photoMax}
              onChange={({ min, max }) => updateFilter({ photoMin: min, photoMax: max })}
              step={1}
              max={60}
              prefix=""
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Captured y/n/both */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">Captured</span>
              {["both", "yes", "no"].map((v) => (
                <button
                  key={v}
                  onClick={() => updateFilter({ captured: v })}
                  className={cn(
                    "h-7 px-2 text-[11px] rounded-md border font-medium transition-colors",
                    filters.captured === v
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                  )}
                >
                  {v}
                </button>
              ))}
            </div>

            <div className="mx-1 h-8 w-px bg-border" />

            <div className="flex items-center gap-1" title="First seen (date range)">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">First seen</span>
              <input
                type="date"
                value={filters.firstSeenFrom}
                onChange={(e) => updateFilter({ firstSeenFrom: e.target.value })}
                className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <span className="text-[10px] text-muted-foreground">–</span>
              <input
                type="date"
                value={filters.firstSeenTo}
                onChange={(e) => updateFilter({ firstSeenTo: e.target.value })}
                className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div className="mx-1 h-8 w-px bg-border" />

            <div className="flex items-center gap-1" title="Days on Market minimum">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">DoM ≥</span>
              <Input
                type="number"
                inputMode="numeric"
                min="0"
                placeholder="0"
                value={filters.domMin}
                onChange={(e) => updateFilter({ domMin: e.target.value })}
                className="h-7 text-xs pl-2 pr-1.5 w-16"
              />
            </div>

            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none ml-2">
              <Switch checked={filters.watched} onCheckedChange={(v) => updateFilter({ watched: v })} />
              <span>Watched only</span>
            </label>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs gap-1 ml-auto"
              onClick={clearFilters}
              disabled={filterCount === 0}
            >
              <X className="h-3 w-3" />
              Clear all
            </Button>
          </div>
        </div>
      )}

      {/* Active filter chip row */}
      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeChips.map((c) => (
            <ActiveChip key={c.k} label={c.label} value={c.value} onClear={c.clear} />
          ))}
          <button
            type="button"
            onClick={clearFilters}
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5 ml-1"
            title="Clear all filters"
          >
            <X className="h-3 w-3" /> clear all
          </button>
        </div>
      )}

      {/* Row-count banner */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div>
          {isFetching ? (
            <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</span>
          ) : total === 0 ? (
            <span>No listings match.</span>
          ) : (
            <>
              Showing <span className="text-foreground font-semibold tabular-nums">{Math.min(listingPage * pageSize + 1, total).toLocaleString()}–{Math.min((listingPage + 1) * pageSize, total).toLocaleString()}</span> of <span className="text-foreground font-semibold tabular-nums">{total.toLocaleString()}</span>
              {filterCount > 0 && <span> (filtered)</span>}
            </>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground/70">
          Keyboard: <kbd className="px-1 py-0.5 rounded bg-muted">j</kbd>/<kbd className="px-1 py-0.5 rounded bg-muted">k</kbd> row · <kbd className="px-1 py-0.5 rounded bg-muted">h</kbd>/<kbd className="px-1 py-0.5 rounded bg-muted">l</kbd> page · <kbd className="px-1 py-0.5 rounded bg-muted">Enter</kbd> open
        </div>
      </div>

      {/* Body — switched by view */}
      {isLoading && total === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card p-12 text-center">
          <Loader2 className="h-6 w-6 mx-auto text-muted-foreground/40 mb-3 animate-spin" />
          <p className="text-sm font-medium text-muted-foreground">Loading listings…</p>
        </div>
      ) : total === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card p-12 text-center">
          <Home className="h-8 w-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No listings found</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Try adjusting the filters or search term</p>
        </div>
      ) : view === "grid" ? (
        <GridView
          rows={filteredRows}
          moByListingId={moByListingId || {}}
          capturedSet={capturedSet || new Set()}
          selectedIds={selectedIds}
          favorites={favorites}
          onToggleSelect={toggleSelectOne}
          onToggleFavorite={toggleFavorite}
          onOpen={openListing}
          allSelected={allSelected}
          someSelected={someSelected}
          toggleSelectAll={toggleSelectAll}
        />
      ) : view === "map" ? (
        <MapView
          rows={filteredRows}
          moByListingId={moByListingId || {}}
          capturedSet={capturedSet || new Set()}
          onOpen={openListing}
        />
      ) : (
        <TableView
          rows={filteredRows}
          moByListingId={moByListingId || {}}
          capturedSet={capturedSet || new Set()}
          selectedIds={selectedIds}
          favorites={favorites}
          focusedRowIdx={focusedRowIdx}
          onToggleSelect={toggleSelectOne}
          onToggleFavorite={toggleFavorite}
          onOpen={openListing}
          onCopyText={copyText}
          allSelected={allSelected}
          someSelected={someSelected}
          toggleSelectAll={toggleSelectAll}
          pulseAgents={pulseAgents}
          pulseAgencies={pulseAgencies}
          crmAgents={crmAgents}
          onOpenEntity={onOpenEntity}
          Th={Th}
        />
      )}

      {/* Pagination (table + grid only) */}
      {total > 0 && view !== "map" && (
        <div className="rounded-xl border border-border/60 bg-card">
          <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 bg-muted/20 gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={listingPage === 0} onClick={() => setListingPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Prev
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                Page {listingPage + 1} of {totalPages}
              </span>
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setListingPage(0); }} className="h-6 text-[11px] rounded border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring" title="Rows per page">
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={listingPage >= totalPages - 1} onClick={() => setListingPage((p) => Math.min(totalPages - 1, p + 1))}>
              Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      <BulkActionBar
        count={selectedIds.size}
        onClear={() => setSelectedIds(new Set())}
        onForceEnrich={handleForceEnrich}
        onWatchlistAgents={handleWatchlistAgents}
        onMarkWatched={handleMarkWatched}
        onExportSelected={handleExportSelected}
        enriching={enriching}
      />

      {/* Slideout fallback (only used when onOpenEntity isn't wired) */}
      {selectedListing && (
        <ListingSlideout
          listing={selectedListing}
          pulseAgents={pulseAgents}
          pulseAgencies={pulseAgencies}
          onOpenEntity={onOpenEntity}
          onClose={() => setSelectedListing(null)}
        />
      )}
    </div>
  );
}

// ── Table view ────────────────────────────────────────────────────────────────

function TableView({
  rows, moByListingId, capturedSet, selectedIds, favorites, focusedRowIdx,
  onToggleSelect, onToggleFavorite, onOpen, onCopyText,
  allSelected, someSelected, toggleSelectAll,
  pulseAgents, pulseAgencies, crmAgents, onOpenEntity, Th,
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 border-b border-border/60">
            <tr>
              <th className="px-2 py-2 w-8">
                <Checkbox
                  checked={allSelected || (someSelected ? "indeterminate" : false)}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all on this page"
                />
              </th>
              <Th className="w-4" />
              <Th className="w-14">Photo</Th>
              <Th col="address">Address</Th>
              <Th col="asking_price">Price</Th>
              <Th className="hidden md:table-cell">Package</Th>
              <Th className="hidden md:table-cell">Tier</Th>
              <Th className="hidden lg:table-cell">Quote</Th>
              <Th col="listing_type">Type</Th>
              <Th col="photo_count" className="hidden sm:table-cell">Photos</Th>
              <Th col="days_on_market" className="hidden sm:table-cell">DoM</Th>
              <Th col="agent_name" className="hidden lg:table-cell">Agent</Th>
              <Th col="agency_name">Agency</Th>
              <Th col="listed_date">Listed</Th>
              <Th className="hidden xl:table-cell">Synced</Th>
              <Th className="w-8" />
              <Th className="w-36 text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {rows.map((l, idx) => {
              const price = sharedDisplayPrice(l).label;
              const thumb = l.image_url || l.hero_image;
              const addr = [l.address, l.suburb, l.postcode].filter(Boolean).join(", ");
              const isFav = favorites.has(l.id);
              const captured = capturedSet.has(l.property_key);
              const mo = moByListingId[l.id];
              const crmAgent = l.agent_rea_id
                ? crmAgents.find((a) => String(a.rea_agent_id) === String(l.agent_rea_id))
                : null;
              const bookUrl = (() => {
                const params = new URLSearchParams();
                params.set("id", "new");
                if (addr) params.set("address", addr);
                if (crmAgent?.id) params.set("agent_id", crmAgent.id);
                if (l.property_key) params.set("property_key", l.property_key);
                return createPageUrl(`ProjectDetails?${params.toString()}`);
              })();

              return (
                <tr
                  key={l.id}
                  className={cn(
                    "group relative hover:bg-muted/30 cursor-pointer transition-colors focus:outline-none",
                    focusedRowIdx === idx && "bg-primary/10"
                  )}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(l)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(l); }
                  }}
                >
                  {/* Select */}
                  <td className="px-2 py-1.5 w-8" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(l.id)}
                      onCheckedChange={() => onToggleSelect(l.id)}
                      aria-label={`Select ${addr || "listing"}`}
                    />
                  </td>

                  {/* Enrichment dot + captured dot (stacked, dense) */}
                  <td className="px-2 py-1.5 w-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col items-center gap-1">
                      <EnrichmentBadge listing={l} compact />
                      <CapturedDot captured={captured} />
                    </div>
                  </td>

                  {/* Photo */}
                  <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                    <Thumb src={thumb} />
                  </td>

                  {/* Address (with quick-preview hover) */}
                  <td className="px-2 py-1.5 max-w-[200px]">
                    <HoverCard openDelay={400} closeDelay={80}>
                      <HoverCardTrigger asChild>
                        <div className="flex items-center gap-1">
                          <p className="truncate font-medium flex-1 min-w-0">{addr || "—"}</p>
                          {isFav && <Star className="h-3 w-3 fill-amber-400 text-amber-500 shrink-0" />}
                          {(() => {
                            const fpArr = Array.isArray(l.floorplan_urls) ? l.floorplan_urls : [];
                            const hasFloorplan = fpArr.length > 0;
                            const hasVideo = !!l.video_url;
                            return (
                              <>
                                {hasFloorplan && <FileImage className="h-3 w-3 text-blue-500 shrink-0" />}
                                {hasVideo && <Video className="h-3 w-3 text-blue-500 shrink-0" />}
                              </>
                            );
                          })()}
                        </div>
                      </HoverCardTrigger>
                      <HoverCardContent align="start" side="right" className="w-64 p-0 border-0 shadow-2xl overflow-hidden">
                        {thumb && (
                          <img src={thumb} alt="" className="w-full h-32 object-cover" />
                        )}
                        <div className="p-3 space-y-1">
                          <div className="text-sm font-semibold leading-tight">{addr || "—"}</div>
                          <div className="text-xs text-muted-foreground">{price}</div>
                          {l.agent_name && (
                            <div className="flex items-center gap-1 text-[11px] text-muted-foreground pt-1 border-t">
                              <User className="h-3 w-3" />
                              <span>{l.agent_name}</span>
                              {l.agent_phone && <span className="text-muted-foreground/70">· {l.agent_phone}</span>}
                            </div>
                          )}
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                    {l.listing_withdrawn_at && (
                      <span className="inline-flex items-center gap-0.5 text-[8px] font-semibold uppercase px-1 py-0 mt-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                        Withdrawn
                      </span>
                    )}
                  </td>

                  {/* Price */}
                  <td className="px-2 py-1.5 tabular-nums font-semibold whitespace-nowrap">
                    {price}
                  </td>

                  {/* Package */}
                  <td className="px-2 py-1.5 hidden md:table-cell">
                    {mo?.classified_package_name
                      ? <PackageBadge listingId={l.id} name={mo.classified_package_name} />
                      : <span className="text-muted-foreground/60 text-[10px]">—</span>}
                  </td>

                  {/* Tier */}
                  <td className="px-2 py-1.5 hidden md:table-cell">
                    <div className="flex flex-col gap-0.5 items-start">
                      <TierBadge tier={mo?.resolved_tier} />
                      <TierSourceStep tierSource={mo?.tier_source} />
                    </div>
                  </td>

                  {/* Quote $ */}
                  <td className="px-2 py-1.5 hidden lg:table-cell tabular-nums">
                    {mo?.quoted_price
                      ? <QuoteAmount listingId={l.id} amount={mo.quoted_price} />
                      : <span className="text-muted-foreground/60 text-[10px]">—</span>}
                  </td>

                  {/* Type */}
                  <td className="px-2 py-1.5">
                    {l.listing_type ? (
                      <span className={cn(
                        "text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap",
                        TYPE_BADGE[l.listing_type] || "bg-muted text-muted-foreground"
                      )}>
                        {TYPE_LABEL[l.listing_type] || l.listing_type}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>

                  {/* Photos */}
                  <td className="px-2 py-1.5 text-muted-foreground tabular-nums whitespace-nowrap hidden sm:table-cell">
                    {l.photo_count > 0 ? l.photo_count : "—"}
                  </td>

                  {/* DoM */}
                  <td className="px-2 py-1.5 text-muted-foreground tabular-nums whitespace-nowrap hidden sm:table-cell">
                    {l.days_on_market > 0 ? `${l.days_on_market}d` : "—"}
                  </td>

                  {/* Agent */}
                  <td className="px-2 py-1.5 max-w-[120px] hidden lg:table-cell">
                    {(() => {
                      const resolvedAgentId = l.agent_pulse_id
                        || pulseAgents.find((a) => a.rea_agent_id === l.agent_rea_id)?.id
                        || null;
                      if (resolvedAgentId && onOpenEntity) {
                        return (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onOpenEntity({ type: "agent", id: resolvedAgentId }); }}
                            className="block w-full text-left truncate cursor-pointer hover:underline hover:text-primary transition-colors"
                          >
                            {l.agent_name || "—"}
                          </button>
                        );
                      }
                      return <p className="truncate">{l.agent_name || "—"}</p>;
                    })()}
                  </td>

                  {/* Agency */}
                  <td className="px-2 py-1.5 max-w-[120px]">
                    {(() => {
                      const resolvedAgencyId = l.agency_pulse_id
                        || pulseAgencies.find((a) => a.rea_agency_id === l.agency_rea_id)?.id
                        || null;
                      if (resolvedAgencyId && onOpenEntity) {
                        return (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onOpenEntity({ type: "agency", id: resolvedAgencyId }); }}
                            className="block w-full text-left truncate text-muted-foreground cursor-pointer hover:underline hover:text-primary transition-colors"
                          >
                            {l.agency_name || "—"}
                          </button>
                        );
                      }
                      return <p className="truncate text-muted-foreground">{l.agency_name || "—"}</p>;
                    })()}
                  </td>

                  {/* Listed */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                    {(() => {
                      const { date, source } = getListingDisplayDate(l);
                      if (!date) return "—";
                      const isApprox = source === "derived" || source === "first_seen";
                      return (
                        <span className={cn(isApprox && "text-muted-foreground/60 italic")} title={DATE_SOURCE_LABEL[source] || ""}>
                          {fmtDate(date)}
                          {isApprox && <span className="ml-1 text-[9px] text-amber-500">≈</span>}
                        </span>
                      );
                    })()}
                  </td>

                  {/* Synced */}
                  <td className="px-2 py-1.5 whitespace-nowrap text-[10px] text-muted-foreground hidden xl:table-cell" title={l.last_synced_at ? new Date(l.last_synced_at).toLocaleString() : "Never synced"}>
                    <span className="inline-flex items-center gap-0.5">
                      <Clock className="h-2.5 w-2.5" />
                      {fmtAgo(l.last_synced_at)}
                    </span>
                    {(() => {
                      const s = stalenessInfo(l.last_synced_at);
                      return s.isStale ? <Badge variant="outline" className="text-[8px] px-1 ml-1 text-amber-700 border-amber-400/60">{s.label}</Badge> : null;
                    })()}
                  </td>

                  {/* Property drill */}
                  <td className="px-2 py-1.5 w-8">
                    {l.property_key ? (
                      <Link
                        to={`/PropertyDetails?key=${encodeURIComponent(l.property_key)}`}
                        onClick={(e) => e.stopPropagation()}
                        title="Open property history"
                        className="inline-flex items-center text-emerald-600 hover:text-emerald-700 transition-colors"
                      >
                        <Home className="h-3.5 w-3.5" />
                      </Link>
                    ) : null}
                  </td>

                  {/* Actions */}
                  <td className="px-2 py-1.5 w-36" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onCopyText(addr, "Address"); }}
                        title="Copy address"
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onCopyText(l.source_url, "Listing URL"); }}
                        disabled={!l.source_url}
                        title="Copy listing URL"
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onToggleFavorite(l.id); }}
                        title={isFav ? "Unfavorite" : "Favorite"}
                        className={cn(
                          "p-1 rounded hover:bg-muted transition-colors",
                          isFav ? "text-amber-500" : "text-muted-foreground hover:text-amber-500"
                        )}
                      >
                        <Star className={cn("h-3 w-3", isFav && "fill-amber-400")} />
                      </button>
                      {l.source_url && (
                        <a href={l.source_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open on realestate.com.au" className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      <a href={bookUrl} onClick={(e) => e.stopPropagation()} title="Book a shoot at this address" className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-emerald-600 transition-colors">
                        <Camera className="h-3 w-3" />
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Grid view ─────────────────────────────────────────────────────────────────

function GridView({
  rows, moByListingId, capturedSet, selectedIds, favorites,
  onToggleSelect, onToggleFavorite, onOpen,
  allSelected, someSelected, toggleSelectAll,
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Checkbox
          checked={allSelected || (someSelected ? "indeterminate" : false)}
          onCheckedChange={toggleSelectAll}
          aria-label="Select all on this page"
        />
        <span className="text-[11px] text-muted-foreground">Select all on page</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {rows.map((l) => (
          <ListingCard
            key={l.id}
            listing={l}
            moRow={moByListingId[l.id]}
            captured={capturedSet.has(l.property_key)}
            selected={selectedIds.has(l.id)}
            favorite={favorites.has(l.id)}
            onToggleSelect={() => onToggleSelect(l.id)}
            onToggleFavorite={() => onToggleFavorite(l.id)}
            onOpen={() => onOpen(l)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Map view ──────────────────────────────────────────────────────────────────
// Lazy-loaded. Imports Leaflet only when user switches to Map view.

function MapView({ rows, moByListingId, capturedSet, onOpen }) {
  const [Mod, setMod] = useState(null);
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [rl, L, cluster] = await Promise.all([
        import("react-leaflet"),
        import("leaflet"),
        import("react-leaflet-cluster"),
      ]);
      // Global CSS imports (no side-effect stripping).
      await import("leaflet/dist/leaflet.css");
      try {
        await import("leaflet.markercluster/dist/MarkerCluster.css");
        await import("leaflet.markercluster/dist/MarkerCluster.Default.css");
      } catch { /* optional */ }
      // Default icon fix (Webpack/Vite strips asset URLs).
      try {
        delete L.default.Icon.Default.prototype._getIconUrl;
        L.default.Icon.Default.mergeOptions({
          iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
          iconUrl:        "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
          shadowUrl:      "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });
      } catch { /* noop */ }
      if (mounted) setMod({ rl, L: L.default, cluster: cluster.default || cluster });
    })();
    return () => { mounted = false; };
  }, []);

  const geoRows = useMemo(
    () => rows.filter((r) => r.latitude != null && r.longitude != null),
    [rows]
  );

  if (!Mod) {
    return (
      <div className="rounded-xl border border-border/60 bg-card h-[600px] flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
      </div>
    );
  }
  const { MapContainer, TileLayer, Marker, Popup } = Mod.rl;
  const L = Mod.L;
  const MarkerClusterGroup = Mod.cluster;

  // Center: average of points, or Sydney fallback.
  const center = geoRows.length > 0
    ? [
        geoRows.reduce((s, r) => s + Number(r.latitude), 0) / geoRows.length,
        geoRows.reduce((s, r) => s + Number(r.longitude), 0) / geoRows.length,
      ]
    : [-33.8688, 151.2093];

  const makeIcon = (captured) => L.divIcon({
    className: "",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    html: `<div style="
      width:14px;height:14px;border-radius:50%;
      background:${captured ? "#10b981" : "#f97316"};
      border:2px solid white;
      box-shadow:0 1px 6px rgba(0,0,0,0.4);
    "></div>`,
  });

  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
      <div className="h-[640px] relative">
        <MapContainer
          center={center}
          zoom={11}
          scrollWheelZoom
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          />
          <MarkerClusterGroup chunkedLoading maxClusterRadius={50}>
            {geoRows.map((l) => {
              const captured = capturedSet.has(l.property_key);
              const mo = moByListingId[l.id];
              return (
                <Marker
                  key={l.id}
                  position={[Number(l.latitude), Number(l.longitude)]}
                  icon={makeIcon(captured)}
                  eventHandlers={{ click: () => { /* popup opens; card click in popup opens slideout */ } }}
                >
                  <Popup maxWidth={280}>
                    <div className="space-y-1" style={{ minWidth: 220 }}>
                      {(l.hero_image || l.image_url) && (
                        <img
                          src={l.hero_image || l.image_url}
                          alt=""
                          className="w-full h-24 object-cover rounded"
                        />
                      )}
                      <div className="text-[13px] font-semibold leading-tight">{l.address || "—"}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {[l.suburb, l.postcode].filter(Boolean).join(" ")}
                      </div>
                      <div className="text-[13px] font-bold tabular-nums">
                        {sharedDisplayPrice(l).label}
                      </div>
                      <div className="flex items-center gap-1.5 pt-1 border-t">
                        {mo?.classified_package_name && (
                          <PackageBadge listingId={l.id} name={mo.classified_package_name} />
                        )}
                        {mo?.resolved_tier && <TierBadge tier={mo.resolved_tier} />}
                        {mo?.tier_source && <TierSourceStep tierSource={mo.tier_source} />}
                        {mo?.quoted_price && (
                          <QuoteAmount listingId={l.id} amount={mo.quoted_price} className="text-[11px]" />
                        )}
                      </div>
                      <div className="flex items-center gap-2 pt-1 border-t">
                        <CapturedDot captured={captured} size="lg" />
                        <span className="text-[10px] uppercase font-semibold">
                          {captured ? "Captured" : "Missed"}
                        </span>
                        <button
                          onClick={() => onOpen(l)}
                          className="ml-auto text-[11px] font-medium text-primary hover:underline"
                        >
                          Open
                        </button>
                      </div>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MarkerClusterGroup>
        </MapContainer>
        {/* Legend overlay */}
        <div className="absolute top-3 right-3 z-[1000] rounded-md border bg-background/95 backdrop-blur px-3 py-2 text-[11px] shadow-sm space-y-1">
          <div className="font-semibold">Legend</div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full bg-emerald-500 border-2 border-white" />
            Captured
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full bg-orange-500 border-2 border-white" />
            Missed
          </div>
          <div className="text-[10px] text-muted-foreground pt-1 border-t">
            {rows.length.toLocaleString()} pins · {geoRows.length.toLocaleString()} geocoded
          </div>
        </div>
      </div>
    </div>
  );
}

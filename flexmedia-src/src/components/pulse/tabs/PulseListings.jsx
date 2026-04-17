/**
 * PulseListings — Listings tab for Industry Pulse.
 * Filterable / sortable / paginated table with a slideout detail panel.
 */
import React, { useState, useMemo, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

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
 *   sold   → sold_date → derived from days_on_market → listed_date → first_seen_at
 *   other  → listed_date → derived from days_on_market + first_seen_at → created_date → first_seen_at
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

const TYPE_FILTERS = [
  { value: "all", label: "All" },
  { value: "for_sale", label: "For Sale" },
  { value: "for_rent", label: "For Rent" },
  { value: "sold", label: "Sold" },
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
  return (
    <img
      src={src}
      alt=""
      className="w-12 h-8 rounded object-cover flex-shrink-0"
      onError={() => setErr(true)}
    />
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

export function ListingSlideout({ listing, pulseAgents, pulseAgencies = [], onClose, onOpenEntity, hasHistory = false, onBack }) {
  const [heroErr, setHeroErr] = useState(false);

  if (!listing) return null;

  const displayPrice =
    listing.listing_type === "sold"
      ? fmtPrice(listing.sold_price || listing.asking_price)
      : fmtPrice(listing.asking_price);

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

  // Parse images array safely
  let images = [];
  try {
    if (Array.isArray(listing.images)) images = listing.images;
    else if (typeof listing.images === "string") images = JSON.parse(listing.images);
  } catch {
    images = [];
  }
  images = images.slice(0, 8);

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
                <DialogTitle className="text-base font-semibold leading-tight">
                  {address || "Unknown address"}
                </DialogTitle>
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
            <span className="text-2xl font-bold tabular-nums">{displayPrice}</span>
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
            {listing.land_size > 0 && (
              <div className="text-muted-foreground text-xs">
                Land: {Number(listing.land_size).toLocaleString()} m²
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
                    <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                      <Phone className="h-2.5 w-2.5" />
                      {listing.agent_phone}
                    </span>
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
                <p className="font-medium">{fmtDate(listing.auction_date)}</p>
              </div>
            )}
            {listing.next_inspection && (
              <div>
                <p className="text-muted-foreground">Next Inspection</p>
                <p className="font-medium">{fmtDate(listing.next_inspection)}</p>
              </div>
            )}
          </div>

          {/* Image gallery */}
          {images.length > 0 && (
            <div className="border-t border-border/60 pt-3">
              <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide">
                Gallery
              </p>
              <div className="flex flex-wrap gap-1.5">
                {images.map((img, i) => {
                  const src = typeof img === "string" ? img : img?.url || img?.src;
                  if (!src) return null;
                  return (
                    <img
                      key={i}
                      src={src}
                      alt={`Photo ${i + 1}`}
                      className="h-16 w-24 object-cover rounded border border-border"
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* External link */}
          {listing.source_url && (
            <div className="border-t border-border/60 pt-3 flex items-center gap-4 flex-wrap">
              <a
                href={listing.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View on realestate.com.au
              </a>
              {listing.property_key && (
                <a
                  href={`/PropertyDetails?key=${encodeURIComponent(listing.property_key)}`}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:underline"
                >
                  <Home className="h-3.5 w-3.5" />
                  Open property history
                </a>
              )}
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
    </Dialog>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PulseListingsTab({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  crmAgents = [],
  search = "",
  onOpenEntity,
}) {
  const [listingFilter, setListingFilter] = useState("all");
  const [listingSort, setListingSort] = useState({ col: "listed_date", dir: "desc" });
  const [listingColFilter, setListingColFilter] = useState("");
  const [listingPage, setListingPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [selectedListing, setSelectedListing] = useState(null);

  // ── Sorting helper ──────────────────────────────────────────────────────────
  const handleSort = useCallback(
    (col) => {
      setListingSort((prev) =>
        prev.col === col
          ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { col, dir: "desc" }
      );
      setListingPage(0);
    },
    []
  );

  // ── Filtered + sorted + paginated listings ──────────────────────────────────
  const { rows, filtered, total } = useMemo(() => {
    const lc = (s) => (s || "").toLowerCase();
    const globalQ = lc(search);
    const colQ = lc(listingColFilter);

    let filtered = pulseListings.filter((l) => {
      // Type filter
      if (listingFilter !== "all" && l.listing_type !== listingFilter) return false;

      // Column text filter
      if (colQ) {
        const hay = [l.suburb, l.agency_name, l.agent_name, l.address]
          .map(lc)
          .join(" ");
        if (!hay.includes(colQ)) return false;
      }

      // Global search
      if (globalQ) {
        const hay = [l.suburb, l.agency_name, l.agent_name, l.address, l.price_text]
          .map(lc)
          .join(" ");
        if (!hay.includes(globalQ)) return false;
      }

      return true;
    });

    // Sort
    const { col, dir } = listingSort;
    const numericCols = new Set(["asking_price", "sold_price", "bedrooms", "bathrooms", "parking", "land_size", "days_on_market"]);
    const dateCols = new Set(["listed_date", "sold_date", "auction_date", "created_at"]);
    const mult = dir === "asc" ? 1 : -1;

    filtered = [...filtered].sort((a, b) => {
      if (numericCols.has(col)) {
        return mult * ((Number(a[col]) || 0) - (Number(b[col]) || 0));
      }
      if (dateCols.has(col)) {
        // For listed_date, sort by the displayed fallback value so rows without
        // a raw listed_date still sort meaningfully (not all at 0).
        if (col === "listed_date") {
          const da = getListingDisplayDate(a).date;
          const db = getListingDisplayDate(b).date;
          const ta = da ? new Date(da).getTime() : 0;
          const tb = db ? new Date(db).getTime() : 0;
          return mult * (ta - tb);
        }
        const da = a[col] ? new Date(a[col]).getTime() : 0;
        const db = b[col] ? new Date(b[col]).getTime() : 0;
        return mult * (da - db);
      }
      return mult * (a[col] || "").localeCompare(b[col] || "");
    });

    const total = filtered.length;
    const rows = filtered.slice(listingPage * pageSize, (listingPage + 1) * pageSize);
    return { rows, filtered, total };
  }, [pulseListings, listingFilter, listingColFilter, listingSort, listingPage, pageSize, search]);

  const totalPages = Math.ceil(total / pageSize);

  // CSV export of filtered set
  const handleExportCsv = useCallback(() => {
    const header = [
      "address", "suburb", "postcode", "listing_type", "asking_price", "sold_price",
      "bedrooms", "bathrooms", "parking", "land_size", "days_on_market",
      "agent_name", "agency_name", "listed_date", "sold_date",
      "property_key", "source_url", "last_synced_at",
    ];
    exportCsv(
      `pulse_listings_${new Date().toISOString().slice(0, 10)}.csv`,
      header,
      filtered
    );
  }, [filtered]);

  // ── Column header helper ────────────────────────────────────────────────────
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

  return (
    <div className="space-y-3">
      {/* ── Filter bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* Type buttons */}
        <div className="flex flex-wrap gap-1">
          {TYPE_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => { setListingFilter(value); setListingPage(0); }}
              className={cn(
                "text-[11px] px-2.5 py-1 rounded-md border font-medium transition-colors",
                listingFilter === value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Column text filter */}
        <div className="flex items-center gap-2 sm:ml-auto">
          <div className="relative">
            <Input
              placeholder="Filter by suburb, agent, agency…"
              value={listingColFilter}
              onChange={(e) => { setListingColFilter(e.target.value); setListingPage(0); }}
              className="h-7 text-xs pl-2.5 pr-6 w-52"
            />
            {listingColFilter && (
              <button
                onClick={() => setListingColFilter("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={handleExportCsv}
            disabled={total === 0}
            title="Export filtered listings as CSV"
          >
            <Download className="h-3 w-3" />
            CSV
          </Button>
          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
            Showing {rows.length} of {total} listings
          </span>
        </div>
      </div>

      {/* ── Table ── */}
      {total === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card p-12 text-center">
          <Home className="h-8 w-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No listings found</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Try adjusting the filters or search term
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 border-b border-border/60">
                <tr>
                  <Th className="w-14">Photo</Th>
                  <Th col="address">Address</Th>
                  <Th col="asking_price">Price</Th>
                  <Th col="listing_type">Type</Th>
                  <Th col="property_type" className="hidden lg:table-cell">Property</Th>
                  <Th col="bedrooms" className="hidden md:table-cell">B/B/C</Th>
                  <Th col="days_on_market" className="hidden sm:table-cell">DOM</Th>
                  <Th col="agent_name" className="hidden lg:table-cell">Agent</Th>
                  <Th col="agency_name">Agency</Th>
                  <Th col="listed_date">Listed</Th>
                  <Th col="sold_date" className="hidden sm:table-cell">Sold Date</Th>
                  <Th className="hidden xl:table-cell">Synced</Th>
                  <Th col="price_text">Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((l) => {
                  const price =
                    l.listing_type === "sold"
                      ? fmtPrice(l.sold_price || l.asking_price)
                      : fmtPrice(l.asking_price);
                  const thumb = l.image_url || l.hero_image;
                  const addr = [l.address, l.suburb, l.postcode]
                    .filter(Boolean)
                    .join(", ");
                  const status = l.price_text || TYPE_LABEL[l.listing_type] || l.listing_type;

                  return (
                    <tr
                      key={l.id}
                      className="hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() =>
                        onOpenEntity
                          ? onOpenEntity({ type: "listing", id: l.id })
                          : setSelectedListing(l)
                      }
                    >
                      {/* Thumbnail */}
                      <td className="px-2 py-1.5">
                        <Thumb src={thumb} />
                      </td>

                      {/* Address */}
                      <td className="px-2 py-1.5 max-w-[180px]">
                        <p className="truncate font-medium">{addr || "—"}</p>
                      </td>

                      {/* Price */}
                      <td className="px-2 py-1.5 tabular-nums font-semibold whitespace-nowrap">
                        {price}
                      </td>

                      {/* Type badge */}
                      <td className="px-2 py-1.5">
                        {l.listing_type ? (
                          <span
                            className={cn(
                              "text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap",
                              TYPE_BADGE[l.listing_type] || "bg-muted text-muted-foreground"
                            )}
                          >
                            {TYPE_LABEL[l.listing_type] || l.listing_type}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* Property type */}
                      <td className="px-2 py-1.5 text-muted-foreground capitalize hidden lg:table-cell">
                        {l.property_type || "—"}
                      </td>

                      {/* Beds / Bath / Car */}
                      <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap hidden md:table-cell">
                        {[l.bedrooms, l.bathrooms, l.parking].every((x) => !x)
                          ? "—"
                          : [l.bedrooms || "–", l.bathrooms || "–", l.parking || "–"].join(" / ")}
                      </td>

                      {/* Days on Market */}
                      <td className="px-2 py-1.5 text-muted-foreground tabular-nums whitespace-nowrap hidden sm:table-cell">
                        {l.days_on_market > 0 ? `${l.days_on_market}d` : "—"}
                      </td>

                      {/* Agent */}
                      <td className="px-2 py-1.5 max-w-[120px] hidden lg:table-cell">
                        <p className="truncate">{l.agent_name || "—"}</p>
                      </td>

                      {/* Agency */}
                      <td className="px-2 py-1.5 max-w-[120px]">
                        <p className="truncate text-muted-foreground">{l.agency_name || "—"}</p>
                      </td>

                      {/* Listed date — with fallback chain */}
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                        {(() => {
                          const { date, source } = getListingDisplayDate(l);
                          if (!date) return "—";
                          const isApprox = source === "derived" || source === "first_seen";
                          return (
                            <span
                              className={cn(isApprox && "text-muted-foreground/60 italic")}
                              title={DATE_SOURCE_LABEL[source] || ""}
                            >
                              {fmtDate(date)}
                              {isApprox && <span className="ml-1 text-[9px] text-amber-500">≈</span>}
                            </span>
                          );
                        })()}
                      </td>

                      {/* Sold date */}
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground hidden sm:table-cell">
                        {l.listing_type === "sold"
                          ? (l.sold_date ? fmtDate(l.sold_date)
                            : l.first_seen_at ? (
                              <span
                                className="text-muted-foreground/60 italic"
                                title={DATE_SOURCE_LABEL.first_seen}
                              >
                                {fmtDate(l.first_seen_at)}
                                <span className="ml-1 text-[9px] text-amber-500">≈</span>
                              </span>
                            ) : "—")
                          : "—"}
                      </td>

                      {/* Last synced */}
                      <td
                        className="px-2 py-1.5 whitespace-nowrap text-[10px] text-muted-foreground hidden xl:table-cell"
                        title={l.last_synced_at ? new Date(l.last_synced_at).toLocaleString() : "Never synced"}
                      >
                        <span className="inline-flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {fmtAgo(l.last_synced_at)}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-2 py-1.5 max-w-[120px]">
                        <p className="truncate text-muted-foreground">{status}</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {total > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 bg-muted/20 gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={listingPage === 0}
                onClick={() => setListingPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                Prev
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  Page {listingPage + 1} of {totalPages}
                </span>
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setListingPage(0); }}
                  className="h-6 text-[11px] rounded border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring"
                  title="Rows per page"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n} / page</option>
                  ))}
                </select>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={listingPage >= totalPages - 1}
                onClick={() => setListingPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Slideout detail ── */}
      {selectedListing && (
        <ListingSlideout
          listing={selectedListing}
          pulseAgents={pulseAgents}
          onClose={() => setSelectedListing(null)}
        />
      )}
    </div>
  );
}

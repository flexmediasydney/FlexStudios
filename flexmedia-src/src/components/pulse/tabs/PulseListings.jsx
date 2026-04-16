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
    return new Date(d).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

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

function ListingSlideout({ listing, pulseAgents, onClose }) {
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
              <DialogTitle className="text-base font-semibold leading-tight">
                {address || "Unknown address"}
              </DialogTitle>
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
            {/* Agent */}
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
                {linkedAgent && (
                  <p className="text-[10px] text-blue-500 mt-0.5">
                    In Pulse: {linkedAgent.full_name}
                  </p>
                )}
              </div>
            </div>

            {/* Agency */}
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
              <p className="text-xs font-medium truncate">
                {listing.agency_name || "—"}
              </p>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-border/60 pt-3 text-[11px]">
            {listing.listed_date && (
              <div>
                <p className="text-muted-foreground">Listed</p>
                <p className="font-medium">{fmtDate(listing.listed_date)}</p>
              </div>
            )}
            {listing.sold_date && (
              <div>
                <p className="text-muted-foreground">Sold</p>
                <p className="font-medium">{fmtDate(listing.sold_date)}</p>
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
            <div className="border-t border-border/60 pt-3">
              <a
                href={listing.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View on realestate.com.au
              </a>
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
}) {
  const [listingFilter, setListingFilter] = useState("all");
  const [listingSort, setListingSort] = useState({ col: "listed_date", dir: "desc" });
  const [listingColFilter, setListingColFilter] = useState("");
  const [listingPage, setListingPage] = useState(0);
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
  const { rows, total } = useMemo(() => {
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
        const da = a[col] ? new Date(a[col]).getTime() : 0;
        const db = b[col] ? new Date(b[col]).getTime() : 0;
        return mult * (da - db);
      }
      return mult * (a[col] || "").localeCompare(b[col] || "");
    });

    const total = filtered.length;
    const rows = filtered.slice(listingPage * PAGE_SIZE, (listingPage + 1) * PAGE_SIZE);
    return { rows, total };
  }, [pulseListings, listingFilter, listingColFilter, listingSort, listingPage, search]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

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
                      onClick={() => setSelectedListing(l)}
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

                      {/* Listed date */}
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                        {fmtDate(l.listed_date)}
                      </td>

                      {/* Sold date */}
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground hidden sm:table-cell">
                        {l.listing_type === "sold" && l.sold_date ? fmtDate(l.sold_date) : "—"}
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
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 bg-muted/20">
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
              <span className="text-[11px] text-muted-foreground">
                Page {listingPage + 1} of {totalPages}
              </span>
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

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
 *     - listing_type filter → .eq("listing_type", ...)
 *     - global search + column filter → .or(ilike on address/suburb/agency_name/agent_name)
 *     - sort column + direction → .order(col, { ascending })
 *
 *   The parent's `pulseListings` prop is kept but now only used by the
 *   slideout for cross-referencing agents/agencies and by the parent's
 *   stat cards. Drill-through to a listing still works because the central
 *   dispatcher in IndustryPulse.jsx resolves by id against the cached array
 *   (bump the cap in useEntityData.jsx if you lift the ceiling).
 *
 *   CSV export fetches the ENTIRE filtered set server-side (separate query,
 *   limit 10000 safety cap), not just the current page.
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  Loader2,
  History,
  FileImage,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import EntitySyncHistoryDialog from "@/components/pulse/EntitySyncHistoryDialog";
import AttachmentLightbox from "@/components/common/AttachmentLightbox";
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
  // Tier 4: source-history drill
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
  // LS09: lightbox index for gallery click-through
  const [lightboxIndex, setLightboxIndex] = useState(null);

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
            <span className="text-2xl font-bold tabular-nums">{displayPriceLabel}</span>
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
                {/* B15: pass auction_time_known so legitimate 10am AEST (00:00 UTC) renders with time */}
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
              <div className="border-t border-border/60 pt-3">
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
                  <div className="border-t border-border/60 pt-3">
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
                      // Extract YouTube video ID if it's a YouTube URL.
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
            {/* Tier 4: sync-run history for this listing */}
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
  "property_type", "price_text",
]);

// Safety cap on the CSV export of the FULL filtered set. 10k × ~40 columns ≈ 4MB,
// which downloads cleanly. Beyond this we'd need a streaming edge fn.
const CSV_EXPORT_CAP = 10000;

// localStorage keys — persisted across reload / tab switches.
const LS_PAGE_SIZE_KEY = "pulse_listings_page_size";
const LS_AUTO_REFRESH_KEY = "pulse_listings_auto_refresh";
const LS_EXCLUDE_WITHDRAWN_KEY = "pulse_listings_exclude_withdrawn";
// Listings are "less urgent than Sources/inbox" per spec — default OFF.
const AUTO_REFRESH_INTERVAL_MS = 60_000;

// LS06: listing types where we default-hide withdrawn campaigns. Sold/UC
// listings should still be visible even if later withdrawn.
const WITHDRAWN_DEFAULT_ON_TYPES = new Set(["for_sale", "for_rent", "all"]);

/** Read a numeric setting from localStorage, falling back to a default. */
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
  // Default ON when nothing has been stored yet.
  return raw === null ? true : raw === "1";
}

export default function PulseListingsTab({
  pulseAgents = [],
  pulseAgencies = [],
  // pulseListings prop is kept for slideout cross-reference and the parent's
  // stat cards, but the TABLE no longer reads from it — we fetch per-page below.
  pulseListings = [],
  crmAgents = [],
  targetSuburbs = [],
  search = "",
  onOpenEntity,
}) {
  // Tier 3 drill-through: pre-fill the column filter from ?suburb= when the
  // Command Center's Suburb Distribution card deep-links into this tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const suburbParam = searchParams.get("suburb");

  const [listingFilter, setListingFilter] = useState("all");
  const [listingSort, setListingSort] = useState({ col: "listed_date", dir: "desc" });
  const [listingColFilter, setListingColFilter] = useState(suburbParam || "");
  // Region filter (Auditor-11 F1) — expands to suburb IN (...) at query time.
  const [regionFilter, setRegionFilter] = useState("all");
  const [listingPage, setListingPage] = useState(0);

  // Consume the URL param once we've seeded state so back/forward doesn't
  // re-fire and the URL stays tidy.
  useEffect(() => {
    if (!suburbParam) return;
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      np.delete("suburb");
      return np;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suburbParam]);
  // Page size persists in localStorage so the user's choice survives reloads
  // and tab switches. Default 50 matches the previous hardcoded value.
  const [pageSize, setPageSize] = useState(readStoredPageSize);
  const [selectedListing, setSelectedListing] = useState(null);
  const [exporting, setExporting] = useState(false);
  // Auto-refresh: opt-in, default off. "Less urgent than Sources/inbox"
  // per spec — listings change every few minutes at most.
  const [autoRefresh, setAutoRefresh] = useState(readStoredAutoRefresh);
  // LS06: "Exclude withdrawn" — default ON for for_sale/for_rent/all; the
  // toggle is still shown/stored for sold/under_contract but has no effect
  // there (those listings shouldn't fan out withdrawn states in practice).
  const [excludeWithdrawn, setExcludeWithdrawn] = useState(readStoredExcludeWithdrawn);

  // Persist page-size changes the moment they happen.
  useEffect(() => {
    try { window.localStorage.setItem(LS_PAGE_SIZE_KEY, String(pageSize)); } catch { /* quota / SSR */ }
  }, [pageSize]);

  // Persist auto-refresh toggle.
  useEffect(() => {
    try { window.localStorage.setItem(LS_AUTO_REFRESH_KEY, autoRefresh ? "1" : "0"); } catch { /* quota / SSR */ }
  }, [autoRefresh]);

  // Persist exclude-withdrawn toggle.
  useEffect(() => {
    try { window.localStorage.setItem(LS_EXCLUDE_WITHDRAWN_KEY, excludeWithdrawn ? "1" : "0"); } catch { /* quota / SSR */ }
  }, [excludeWithdrawn]);

  // ── Region filter derivations (Auditor-11 F1) ─────────────────────────────
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

  // Reset to page 0 when filters/sort/search change so we never page past the
  // new result window. Must happen AFTER a filter change and BEFORE the
  // useQuery fires (React runs state updates before committing).
  useEffect(() => { setListingPage(0); }, [listingFilter, listingColFilter, regionFilter, pageSize, search, listingSort.col, listingSort.dir, excludeWithdrawn]);

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

  // ── Server-side query builder ──────────────────────────────────────────────
  const buildQuery = useCallback((baseSelect, withCount) => {
    let q = api._supabase
      .from("pulse_listings")
      .select(baseSelect, withCount ? { count: "exact" } : undefined);

    // Type filter (server-side equality)
    if (listingFilter !== "all") {
      q = q.eq("listing_type", listingFilter);
    }

    // LS06: exclude withdrawn campaigns when the toggle is on, but only for
    // listing types where withdrawn ≠ final state (for_sale / for_rent / all).
    if (excludeWithdrawn && WITHDRAWN_DEFAULT_ON_TYPES.has(listingFilter)) {
      q = q.is("listing_withdrawn_at", null);
    }

    // Column filter (server-side ilike OR across likely fields)
    const colQ = (listingColFilter || "").trim();
    if (colQ) {
      const s = colQ.replace(/[%_]/g, "\\$&");
      q = q.or(`address.ilike.%${s}%,suburb.ilike.%${s}%,agency_name.ilike.%${s}%,agent_name.ilike.%${s}%`);
    }

    // Region filter (Auditor-11 F1) — expands to suburb IN (...).
    if (suburbsInRegion) {
      if (suburbsInRegion.length === 0) {
        q = q.eq("id", "00000000-0000-0000-0000-000000000000");
      } else {
        q = q.in("suburb", suburbsInRegion);
      }
    }

    // PF02: global search uses the trigger-maintained `search_text` column
    // (address + suburb + postcode + agent_name + agency_name + price_text +
    // property_type + listing_type, lowercased) backed by a GIN trigram
    // index. Single ilike call — same pattern as PulseAgentIntel /
    // PulseAgencyIntel. See migration 124_performance_indexes.sql.
    const globalQ = (search || "").trim();
    if (globalQ) {
      const s = globalQ.toLowerCase().replace(/[%_]/g, "\\$&");
      q = q.ilike("search_text", `%${s}%`);
    }

    // Server-side sort — falls back to created_at desc for columns PostgREST
    // can't sort on (derived/display-only fields like getListingDisplayDate).
    const sortCol = SERVER_SORTABLE.has(listingSort.col) ? listingSort.col : "created_at";
    q = q.order(sortCol, { ascending: listingSort.dir === "asc", nullsFirst: false });

    return q;
  }, [listingFilter, listingColFilter, search, listingSort, excludeWithdrawn, suburbsInRegion]);

  // ── Page fetch via react-query ─────────────────────────────────────────────
  const queryKey = useMemo(
    () => ["pulse-listings-page", {
      listingFilter, listingColFilter, regionFilter, search,
      sortCol: listingSort.col, sortDir: listingSort.dir,
      page: listingPage, pageSize, excludeWithdrawn,
    }],
    [listingFilter, listingColFilter, regionFilter, search, listingSort, listingPage, pageSize, excludeWithdrawn],
  );

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const from = listingPage * pageSize;
      const to = from + pageSize - 1;
      const q = buildQuery("*", true).range(from, to);
      const { data: rows, count, error } = await q;
      if (error) throw error;
      return { rows: rows || [], count: count || 0 };
    },
    keepPreviousData: true,
    staleTime: 30_000,
    // Refetch on an interval when autoRefresh is on — react-query handles
    // the pause while the tab is hidden in the background.
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const rows = data?.rows || [];
  const total = data?.count || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // CSV export: fetch the ENTIRE filtered set (up to CSV_EXPORT_CAP) — not
  // just the current page. Two-step: hit count:exact first to decide whether
  // to warn, then page through in chunks of 1000 (PostgREST cap).
  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      // Count first so we can warn if > cap
      const headQ = buildQuery("id", true).limit(1);
      const { count: totalCount, error: countErr } = await headQ;
      if (countErr) throw countErr;
      const cap = Math.min(totalCount || 0, CSV_EXPORT_CAP);
      if ((totalCount || 0) > CSV_EXPORT_CAP) {
        // eslint-disable-next-line no-alert
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
      // Serialise array/object cells so the CSV stays single-line-per-row.
      const flatRows = all.map((r) => ({
        ...r,
        floorplan_urls: Array.isArray(r.floorplan_urls)
          ? r.floorplan_urls.join(" | ")
          : (r.floorplan_urls ?? ""),
      }));
      exportCsv(`pulse_listings_${new Date().toISOString().slice(0, 10)}.csv`, header, flatRows);
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`CSV export failed: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  }, [buildQuery]);

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
          {/* Region filter (Auditor-11 F1) */}
          {regions.length > 0 && (
            <select
              value={regionFilter}
              onChange={(e) => { setRegionFilter(e.target.value); setListingPage(0); }}
              className="h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              title="Filter by region — expands to all suburbs in that region"
            >
              <option value="all">All regions</option>
              {regions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          )}
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
            disabled={total === 0 || exporting}
            title="Export filtered listings as CSV (server-side, up to 10k rows)"
          >
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            CSV
          </Button>
          {/* Auto-refresh toggle — opt-in, default off. Listings change slowly
              so we don't want to hammer the DB by default. */}
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
          {/* LS06: Exclude withdrawn — default ON for for_sale/for_rent/all.
              Disabled (shown faded) when current type filter is sold/UC since
              it has no effect there. */}
          <label
            className={cn(
              "flex items-center gap-1.5 text-[11px] cursor-pointer select-none",
              WITHDRAWN_DEFAULT_ON_TYPES.has(listingFilter)
                ? "text-muted-foreground"
                : "text-muted-foreground/50 cursor-not-allowed"
            )}
            title={
              WITHDRAWN_DEFAULT_ON_TYPES.has(listingFilter)
                ? "Hide listings flagged as withdrawn on REA"
                : "Not applicable — current type doesn't surface withdrawn campaigns"
            }
          >
            <Switch
              checked={excludeWithdrawn}
              onCheckedChange={setExcludeWithdrawn}
              disabled={!WITHDRAWN_DEFAULT_ON_TYPES.has(listingFilter)}
              aria-label="Exclude withdrawn listings"
            />
            <span>Exclude withdrawn</span>
          </label>
          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
            {isFetching ? (
              <Loader2 className="inline h-3 w-3 animate-spin" />
            ) : total === 0 ? (
              <>Showing 0 of 0 listings</>
            ) : (
              <>Showing {Math.min(listingPage * pageSize + 1, total).toLocaleString()}–{Math.min((listingPage + 1) * pageSize, total).toLocaleString()} of {total.toLocaleString()} listings</>
            )}
          </span>
        </div>
      </div>

      {/* ── Table ── */}
      {isLoading && total === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card p-12 text-center">
          <Loader2 className="h-6 w-6 mx-auto text-muted-foreground/40 mb-3 animate-spin" />
          <p className="text-sm font-medium text-muted-foreground">Loading listings…</p>
        </div>
      ) : total === 0 ? (
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
                  {/* Tier 3: Property drill-through icon column (only populated
                      when property_key is set on the listing). */}
                  <Th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((l) => {
                  // Canonical price label via shared helper — handles sold/rent/
                  // under_contract ordering consistently across all renderers.
                  const price = sharedDisplayPrice(l).label;
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

                      {/* Address — with floorplan/video/withdrawn indicators (migration 108+) */}
                      <td className="px-2 py-1.5 max-w-[180px]">
                        <div className="flex items-center gap-1">
                          <p className="truncate font-medium flex-1 min-w-0">{addr || "—"}</p>
                          {(() => {
                            const fpArr = Array.isArray(l.floorplan_urls) ? l.floorplan_urls : [];
                            const hasFloorplan = fpArr.length > 0;
                            const hasVideo = !!l.video_url;
                            return (
                              <>
                                {hasFloorplan && (
                                  <FileImage
                                    className="h-3 w-3 text-blue-500 shrink-0"
                                    title={`${fpArr.length} floorplan${fpArr.length !== 1 ? "s" : ""}`}
                                  />
                                )}
                                {hasVideo && (
                                  <Video
                                    className="h-3 w-3 text-blue-500 shrink-0"
                                    title="Video available"
                                  />
                                )}
                              </>
                            );
                          })()}
                        </div>
                        {l.listing_withdrawn_at && (
                          <span className="inline-flex items-center gap-0.5 text-[8px] font-semibold uppercase px-1 py-0 mt-0.5 rounded bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/20 dark:text-red-400 dark:border-red-900/40">
                            Withdrawn
                          </span>
                        )}
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

                      {/* Last synced — with stale badge when last_synced_at is >7d old */}
                      <td
                        className="px-2 py-1.5 whitespace-nowrap text-[10px] text-muted-foreground hidden xl:table-cell"
                        title={l.last_synced_at ? new Date(l.last_synced_at).toLocaleString() : "Never synced"}
                      >
                        <span className="inline-flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {fmtAgo(l.last_synced_at)}
                        </span>
                        {(() => {
                          const s = stalenessInfo(l.last_synced_at);
                          return s.isStale ? (
                            <Badge variant="outline" className="text-[8px] px-1 ml-1 text-amber-700 border-amber-400/60">
                              {s.label}
                            </Badge>
                          ) : null;
                        })()}
                      </td>

                      {/* Status */}
                      <td className="px-2 py-1.5 max-w-[120px]">
                        <p className="truncate text-muted-foreground">{status}</p>
                      </td>

                      {/* Tier 3: property drill-through — only when
                          property_key is set. Stops row-click propagation so
                          the listing slideout doesn't also open. */}
                      <td className="px-2 py-1.5 w-8">
                        {l.property_key ? (
                          <a
                            href={`/PropertyDetails?key=${encodeURIComponent(l.property_key)}`}
                            onClick={(e) => e.stopPropagation()}
                            title="Open property history"
                            className="inline-flex items-center text-emerald-600 hover:text-emerald-700 transition-colors"
                          >
                            <Home className="h-3.5 w-3.5" />
                          </a>
                        ) : null}
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
          pulseAgencies={pulseAgencies}
          onOpenEntity={onOpenEntity}
          onClose={() => setSelectedListing(null)}
        />
      )}
    </div>
  );
}

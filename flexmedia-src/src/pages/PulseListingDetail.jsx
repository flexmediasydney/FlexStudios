/**
 * PulseListingDetail — W15b.8
 *
 * Per-listing detail page for Pulse listings. Provides a tabbed surface for
 * deep-diving into a single listing — currently:
 *
 *   - Overview      summary + hero + price + agent/agency cross-references
 *                   (delegates to the existing slideout layout — see
 *                   ListingSlideout in pulse/tabs/PulseListings.jsx for the
 *                   richer canvas)
 *   - Vision        per-image Gemini classification + aggregate breakdown
 *
 * Route: /PulseListingDetail?id=<uuid>&tab=<overview|vision>
 *
 * Why a dedicated page (vs. a slideout-only flow)?
 *   The slideout in IndustryPulse keeps the listing inline with the table
 *   for fast triage. The detail page is a stable URL the operator can share
 *   ("send me the vision view of 12 main st") and supports deep-link
 *   bookmarking. Both share the same underlying data — no duplication.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChevronLeft,
  Loader2,
  Sparkles,
  Home,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { createPageUrl } from "@/utils";
import PulseListingVisionTab from "@/components/pulse/listing-detail/PulseListingVisionTab";
import {
  displayPrice as sharedDisplayPrice,
  parseMediaItems,
} from "@/components/pulse/utils/listingHelpers";

// ── URL helpers ──────────────────────────────────────────────────────────────

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "vision", label: "Vision Analysis" },
];
const TAB_KEYS = new Set(TABS.map((t) => t.key));

// ── Hook: fetch one listing ──────────────────────────────────────────────────

function useListing(listingId) {
  return useQuery({
    enabled: Boolean(listingId),
    queryKey: ["pulse-listing-detail", listingId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pulse_listings")
        .select("*")
        .eq("id", listingId)
        .maybeSingle();
      if (error) throw new Error(error.message || "Failed to load listing.");
      return data || null;
    },
    staleTime: 60_000,
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PulseListingDetail() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const listingId = searchParams.get("id");

  const tabParam = searchParams.get("tab");
  const initialTab = tabParam && TAB_KEYS.has(tabParam) ? tabParam : "overview";
  const [tab, setTab] = useState(initialTab);

  // Sync tab → URL
  useEffect(() => {
    if (tab === searchParams.get("tab")) return;
    const next = new URLSearchParams(searchParams);
    if (tab === "overview") next.delete("tab");
    else next.set("tab", tab);
    setSearchParams(next, { replace: true });
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const listingQuery = useListing(listingId);
  const listing = listingQuery.data || null;

  const address = useMemo(() => {
    if (!listing) return "";
    return [listing.address, listing.suburb, listing.postcode].filter(Boolean).join(", ");
  }, [listing]);

  const heroSrc = listing?.hero_image || listing?.image_url || null;
  const priceLabel = listing ? sharedDisplayPrice(listing).label : "—";

  // ── States ─────────────────────────────────────────────────────────────────
  if (!listingId) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card className="border-amber-200 bg-amber-50/40 dark:bg-amber-950/10">
          <CardContent className="p-4 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <div>
              <div className="font-semibold">No listing selected</div>
              <p className="mt-1 text-xs">Add an <code>?id=</code> query parameter to view a listing.</p>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to={createPageUrl("IndustryPulse")}>Back to Pulse</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (listingQuery.isLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[40vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (listingQuery.isError || !listing) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card className="border-red-200 bg-red-50/40 dark:bg-red-950/10">
          <CardContent className="p-4 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <div>
              <div className="font-semibold">Couldn't load listing</div>
              <p className="mt-1 text-xs">
                {listingQuery.error?.message || "This listing may have been deleted or is no longer accessible."}
              </p>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to={createPageUrl("IndustryPulse")}>Back to Pulse</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4" data-testid="pulse-listing-detail">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {heroSrc && (
          <img
            src={heroSrc}
            alt=""
            className="h-16 w-24 sm:h-20 sm:w-32 object-cover rounded-md border border-border/60 shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-base sm:text-lg font-semibold leading-tight truncate" title={address}>
            {address || "Unknown address"}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="text-base font-bold tabular-nums text-foreground">{priceLabel}</span>
            {listing.listing_type && (
              <Badge variant="outline" className="text-[10px]">{listing.listing_type}</Badge>
            )}
            {listing.agent_name && <span>· {listing.agent_name}</span>}
            {listing.agency_name && <span className="text-muted-foreground/80">@ {listing.agency_name}</span>}
          </div>
        </div>
        {listing.source_url && (
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <a href={listing.source_url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3 w-3 mr-1" />
              REA
            </a>
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="grid grid-cols-2 max-w-md">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              className="text-xs px-2 py-1.5"
              data-testid={`tab-${t.key}`}
            >
              {t.key === "vision" && <Sparkles className="h-3 w-3 mr-1" />}
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-3">
          <OverviewTab listing={listing} />
        </TabsContent>

        <TabsContent value="vision" className="mt-4">
          <PulseListingVisionTab listing={listing} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Overview tab — light summary, the listing slideout has the rich version ──

function OverviewTab({ listing }) {
  const { photos = [], floorplans = [], video } = parseMediaItems(listing) || {};
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Stat label="Photos" value={photos.length} />
          <Stat label="Floorplans" value={floorplans.length} />
          <Stat label="Video" value={video ? "yes" : "no"} />
          <Stat label="DoM" value={listing.days_on_market ?? "—"} />
          <Stat label="Bedrooms" value={listing.bedrooms ?? "—"} />
          <Stat label="Bathrooms" value={listing.bathrooms ?? "—"} />
          <Stat label="Parking" value={listing.car_spaces ?? "—"} />
          <Stat label="Land area" value={listing.land_area_sqm ? `${listing.land_area_sqm} m²` : "—"} />
        </CardContent>
      </Card>

      {photos.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Photos ({photos.length})
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {photos.slice(0, 12).map((p, i) => (
                <div key={i} className="aspect-[3/2] bg-muted rounded overflow-hidden">
                  <img
                    src={p.thumb || p.url}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
            </div>
            {photos.length > 12 && (
              <div className="text-[11px] text-muted-foreground mt-2">
                + {photos.length - 12} more — use Vision Analysis tab for the full grid with classifications.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value ?? "—"}</div>
    </div>
  );
}

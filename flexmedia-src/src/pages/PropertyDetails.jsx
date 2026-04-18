/**
 * PropertyDetails — full property dossier (Phase 1 of the dossier vision)
 *
 * URL: /PropertyDetails?key=<property_key>
 *
 * Page layout:
 *   STICKY HEADER (40-48px) — back / address / status / Favorite / Share
 *   HERO               — 60/40 image + price/facts/agent card (stacks on mobile)
 *   SIGNAL RIBBON      — stacked banners per unresolved signal
 *   INTELLIGENCE STRIP — 7 tiles (2x4 on mobile)
 *   TABS               — Timeline | Media | Projects | Agents
 *   RIGHT-RAIL         — Currently listed by / Next event / Our history (≥1280px)
 *
 * Data: single RPC call `property_get_full_dossier(p_property_key)` returning
 * `{ property, listings, projects, agents, agencies, timeline_events,
 *    signals, upcoming_events, relist_candidate, comparables, neighbour_clients }`.
 *
 * Shared helpers (parseMediaItems, displayPrice, formatAuctionDateTime) come
 * from `@/components/pulse/utils/listingHelpers` so every pulse-facing page
 * renders prices / media / dates identically. Do NOT roll inline fallbacks.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import AttachmentLightbox from "@/components/common/AttachmentLightbox";
import { toast } from "sonner";
import {
  Home, MapPin, ArrowLeft, Share2, Star, Images, Video, Camera, Calendar,
  Clock, TrendingUp, TrendingDown, DollarSign, Building2, Tag, AlertTriangle,
  Bed, Bath, Car, ExternalLink, Phone, Mail, Users, History,
  ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp, Play, FileText, CheckCircle2,
  XCircle, Eye, List, BarChart3,
} from "lucide-react";
import {
  formatAuctionDateTime,
  parseMediaItems,
  displayPrice,
  LISTING_TYPE_LABEL,
  listingTypeBadgeClasses,
} from "@/components/pulse/utils/listingHelpers";
import { ListingSlideout } from "@/components/pulse/tabs/PulseListings";
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, Tooltip as RTooltip,
  Legend, ReferenceArea, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { useIsMobile } from "@/hooks/use-mobile";

// ── Colour / format helpers ──────────────────────────────────────────────

/**
 * Convert a hex color to rgba(…). Copied verbatim from the helper pattern in
 * PulseAgencyIntel.jsx:172 so agency brand accents render identically across
 * the app. Returns null when the hex is unparseable.
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

function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  } catch { return "—"; }
}

function fmtMonthYear(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", { month: "short", year: "numeric" });
  } catch { return "—"; }
}

function fmtRelative(d) {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  if (!isFinite(ms)) return "—";
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function fmtLand(sqm) {
  if (!sqm || sqm <= 0) return null;
  if (sqm >= 10000) return `${(sqm / 10000).toFixed(2)} ha`;
  return `${Math.round(sqm).toLocaleString()} m²`;
}

function initials(name) {
  if (!name) return "??";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Root page component ──────────────────────────────────────────────────

export default function PropertyDetails() {
  const location = useLocation();
  const propertyKey = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("key");
  }, [location.search]);

  // Tabs: default = timeline. Arrow keys navigate between tabs (A11y).
  const TAB_ORDER = ["timeline", "media", "listings", "projects", "agents", "market"];
  const [tab, setTab] = useState("timeline");
  const tabsRef = useRef(null);

  // Flash-highlight state: Price-Timeline-Chart dots fire this; TimelineTab
  // listens for it and momentarily highlights the matching card.
  const [flashedEventId, setFlashedEventId] = useState(null);
  const handleChartDotClick = useCallback((eventId) => {
    if (!eventId) return;
    setTab("timeline");
    setFlashedEventId(eventId);
    // Scroll tab rail into view
    requestAnimationFrame(() => {
      tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    // Clear flash after 2s so it can re-trigger
    window.setTimeout(() => setFlashedEventId(null), 2000);
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      // Only intercept when focus isn't inside an input/textarea/button
      const t = document.activeElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const idx = TAB_ORDER.indexOf(tab);
        if (idx < 0) return;
        const next = e.key === "ArrowLeft"
          ? TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length]
          : TAB_ORDER[(idx + 1) % TAB_ORDER.length];
        setTab(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  // ── Data fetch — single RPC via react-query ────────────────────────────
  const {
    data: dossier,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["property-dossier", propertyKey],
    queryFn: async () => {
      if (!propertyKey) return null;
      const { data, error: rpcErr } = await api._supabase.rpc(
        "property_get_full_dossier",
        { p_property_key: propertyKey }
      );
      if (rpcErr) throw rpcErr;
      return data || {};
    },
    enabled: !!propertyKey,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Favorite (LocalStorage) ────────────────────────────────────────────
  const [isFavorite, setIsFavorite] = useState(false);
  useEffect(() => {
    if (!propertyKey) return;
    try {
      const favs = JSON.parse(localStorage.getItem("flex_favorite_properties") || "[]");
      setIsFavorite(favs.includes(propertyKey));
    } catch { /* noop */ }
  }, [propertyKey]);
  const toggleFavorite = useCallback(() => {
    if (!propertyKey) return;
    try {
      const favs = JSON.parse(localStorage.getItem("flex_favorite_properties") || "[]");
      let next;
      if (favs.includes(propertyKey)) {
        next = favs.filter((k) => k !== propertyKey);
        toast.success("Removed from favorites");
      } else {
        next = [...favs, propertyKey];
        toast.success("Added to favorites");
      }
      localStorage.setItem("flex_favorite_properties", JSON.stringify(next));
      setIsFavorite(next.includes(propertyKey));
    } catch { /* noop */ }
  }, [propertyKey]);

  const shareLink = useCallback(() => {
    try {
      const url = window.location.href;
      navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Failed to copy link");
    }
  }, []);

  // ── Derived values from dossier ────────────────────────────────────────
  const property = dossier?.property || null;
  const listings = dossier?.listings || [];
  const projects = dossier?.projects || [];
  const agents = dossier?.agents || [];
  const agencies = dossier?.agencies || [];
  const timelineEvents = dossier?.timeline_events || [];
  const signals = dossier?.signals || [];
  const upcomingEvents = dossier?.upcoming_events || [];
  const relistCandidate = dossier?.relist_candidate || null;
  const comparables = dossier?.comparables || [];

  const currentListing = listings[0] || null;
  const currentAgency = useMemo(() => {
    if (!currentListing?.agency_rea_id) return null;
    return agencies.find((a) => String(a.rea_agency_id) === String(currentListing.agency_rea_id))
      || null;
  }, [currentListing, agencies]);
  const currentAgent = useMemo(() => {
    if (!currentListing?.agent_rea_id) return null;
    return agents.find((a) => String(a.rea_agent_id) === String(currentListing.agent_rea_id))
      || null;
  }, [currentListing, agents]);

  // ── Early returns ──────────────────────────────────────────────────────
  if (!propertyKey) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6">
        <Card><CardContent className="py-12 text-center text-muted-foreground">
          <p>Missing property key in URL.</p>
          <Link to="/Properties"><Button variant="outline" size="sm" className="mt-2">Back to Properties</Button></Link>
        </CardContent></Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6">
        <Card><CardContent className="py-12 text-center">
          <AlertTriangle className="h-10 w-10 mx-auto mb-2 opacity-60 text-red-500" />
          <p className="text-sm text-foreground mb-1">Failed to load property</p>
          <p className="text-xs text-muted-foreground mb-3">{error.message || "Unknown error"}</p>
          <div className="flex items-center gap-2 justify-center">
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
            <Link to="/Properties"><Button variant="outline" size="sm">Back</Button></Link>
          </div>
        </CardContent></Card>
      </div>
    );
  }

  if (isLoading || !dossier) {
    return <PropertyDetailsSkeleton />;
  }

  if (!property) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6">
        <Card><CardContent className="py-12 text-center">
          <Home className="h-10 w-10 mx-auto mb-2 opacity-30 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Property not found.</p>
          <Link to="/Properties"><Button variant="outline" size="sm" className="mt-2">Back to Properties</Button></Link>
        </CardContent></Card>
      </div>
    );
  }

  // Combined upcoming events: RPC-provided + current listing's auction_date.
  const combinedUpcoming = (() => {
    const out = [...(upcomingEvents || [])];
    if (currentListing?.auction_date) {
      const whenMs = new Date(currentListing.auction_date).getTime();
      if (isFinite(whenMs) && whenMs > Date.now()) {
        out.push({
          kind: "auction",
          event_date: currentListing.auction_date,
          title: "Auction",
          listing_id: currentListing.id,
          time_known: currentListing.auction_time_known,
        });
      }
    }
    return out
      .filter((e) => e?.event_date)
      .sort((a, b) => new Date(a.event_date) - new Date(b.event_date))
      .slice(0, 3);
  })();

  return (
    <div className="pb-4 lg:pb-6">
      {/* ── STICKY HEADER ── */}
      <StickyHeader
        property={property}
        isFavorite={isFavorite}
        onToggleFavorite={toggleFavorite}
        onShare={shareLink}
      />

      <div className="px-3 pt-2 space-y-3 lg:px-6">
        {/* ── Right-rail layout wrapper ── */}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr,320px] gap-4">
          {/* MAIN COLUMN */}
          <div className="space-y-3 min-w-0">
            {/* ── HERO ── */}
            <ErrorBoundary compact fallbackLabel="Hero">
              <PropertyHero
                property={property}
                listings={listings}
                currentListing={currentListing}
                currentAgent={currentAgent}
                currentAgency={currentAgency}
              />
            </ErrorBoundary>

            {/* ── SIGNAL RIBBON (stack all) ── */}
            {(signals.length > 0 || relistCandidate?.is_candidate) && (
              <ErrorBoundary compact fallbackLabel="Signal ribbon">
                <SignalRibbon
                  signals={signals}
                  relistCandidate={relistCandidate}
                />
              </ErrorBoundary>
            )}

            {/* ── MOBILE-ONLY inline right-rail cards (above tabs) ── */}
            <div className="xl:hidden space-y-3">
              {currentAgency && (
                <CurrentlyListedByCard
                  agency={currentAgency}
                  agent={currentAgent}
                  listing={currentListing}
                />
              )}
              {combinedUpcoming.length > 0 && (
                <NextEventCard upcoming={combinedUpcoming} />
              )}
              {projects.length > 0 && (
                <OurHistoryCard projects={projects.slice(0, 3)} />
              )}
            </div>

            {/* ── INTELLIGENCE STRIP ── */}
            <ErrorBoundary compact fallbackLabel="Intelligence strip">
              <IntelligenceStrip
                property={property}
                listings={listings}
                projects={projects}
                onTileClick={(target) => setTab(target)}
              />
            </ErrorBoundary>

            {/* ── PRICE TIMELINE CHART (Phase 2) ── */}
            <ErrorBoundary compact fallbackLabel="Price timeline">
              <PriceTimelineChart
                listings={listings}
                projects={projects}
                onDotClick={handleChartDotClick}
              />
            </ErrorBoundary>

            {/* ── TABS ── */}
            <div ref={tabsRef}>
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="flex flex-wrap h-auto gap-0.5 w-full rounded-lg bg-muted p-1">
                  <TabsTrigger value="timeline" className="flex-1 text-xs sm:text-sm">
                    <History className="h-3.5 w-3.5 mr-1.5" />
                    Timeline
                    {timelineEvents.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[9px] tabular-nums">
                        {timelineEvents.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="media" className="flex-1 text-xs sm:text-sm">
                    <Images className="h-3.5 w-3.5 mr-1.5" />
                    Media
                  </TabsTrigger>
                  <TabsTrigger value="listings" className="flex-1 text-xs sm:text-sm">
                    <List className="h-3.5 w-3.5 mr-1.5" />
                    Listings
                    {listings.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[9px] tabular-nums">
                        {listings.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="projects" className="flex-1 text-xs sm:text-sm">
                    <Camera className="h-3.5 w-3.5 mr-1.5" />
                    Projects
                    {projects.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[9px] tabular-nums">
                        {projects.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="agents" className="flex-1 text-xs sm:text-sm">
                    <Users className="h-3.5 w-3.5 mr-1.5" />
                    Agents
                    {agents.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[9px] tabular-nums">
                        {agents.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="market" className="flex-1 text-xs sm:text-sm">
                    <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
                    Market
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="timeline" className="mt-3">
                  <ErrorBoundary compact fallbackLabel="Timeline">
                    <TimelineTab
                      events={timelineEvents}
                      listings={listings}
                      projects={projects}
                      flashedEventId={flashedEventId}
                    />
                  </ErrorBoundary>
                </TabsContent>

                <TabsContent value="media" className="mt-3">
                  <ErrorBoundary compact fallbackLabel="Media">
                    <MediaTab listings={listings} />
                  </ErrorBoundary>
                </TabsContent>

                <TabsContent value="listings" className="mt-3">
                  <ErrorBoundary compact fallbackLabel="Listings">
                    <ListingsTab
                      initialListings={listings}
                      agents={agents}
                      agencies={agencies}
                      propertyKey={propertyKey}
                    />
                  </ErrorBoundary>
                </TabsContent>

                <TabsContent value="projects" className="mt-3">
                  <ErrorBoundary compact fallbackLabel="Projects">
                    <ProjectsTab projects={projects} property={property} />
                  </ErrorBoundary>
                </TabsContent>

                <TabsContent value="agents" className="mt-3">
                  <ErrorBoundary compact fallbackLabel="Agents">
                    <AgentsTab
                      agents={agents}
                      agencies={agencies}
                      listings={listings}
                      projects={projects}
                    />
                  </ErrorBoundary>
                </TabsContent>

                <TabsContent value="market" className="mt-3">
                  <ErrorBoundary compact fallbackLabel="Market">
                    <MarketTab
                      comparables={comparables}
                      neighbours={dossier?.neighbour_clients || []}
                      suburb={property?.suburb || null}
                    />
                  </ErrorBoundary>
                </TabsContent>
              </Tabs>
            </div>
          </div>

          {/* RIGHT RAIL — desktop ≥1280px only */}
          <aside className="hidden xl:block">
            <div className="sticky top-[64px] space-y-3">
              {currentAgency && (
                <ErrorBoundary compact fallbackLabel="Currently listed by">
                  <CurrentlyListedByCard
                    agency={currentAgency}
                    agent={currentAgent}
                    listing={currentListing}
                  />
                </ErrorBoundary>
              )}
              {combinedUpcoming.length > 0 && (
                <ErrorBoundary compact fallbackLabel="Next event">
                  <NextEventCard upcoming={combinedUpcoming} />
                </ErrorBoundary>
              )}
              {projects.length > 0 && (
                <ErrorBoundary compact fallbackLabel="Our history">
                  <OurHistoryCard projects={projects.slice(0, 5)} />
                </ErrorBoundary>
              )}
              {comparables.length > 0 && (
                <ErrorBoundary compact fallbackLabel="Comparables">
                  <ComparablesCard comparables={comparables} />
                </ErrorBoundary>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ── Sticky header ────────────────────────────────────────────────────────

function StickyHeader({ property, isFavorite, onToggleFavorite, onShare }) {
  const statusInfo = useMemo(() => {
    if (!property?.current_listing_type) {
      if (property?.latest_sold_date) {
        const ms = Date.now() - new Date(property.latest_sold_date).getTime();
        if (ms < 180 * 86400000) {
          return { label: "Recently Sold", cls: listingTypeBadgeClasses("sold") };
        }
      }
      return null;
    }
    const type = property.current_listing_type;
    return {
      label: LISTING_TYPE_LABEL[type] || type,
      cls: listingTypeBadgeClasses(type),
    };
  }, [property]);

  return (
    <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-border">
      <div className="h-10 sm:h-12 px-3 lg:px-6 flex items-center gap-2">
        <Link to="/Properties">
          <Button variant="ghost" size="sm" className="h-8 px-2 shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Home className="h-4 w-4 text-primary shrink-0 hidden sm:inline" />
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-semibold truncate leading-tight">
              {property?.display_address || "—"}
            </p>
            <p className="text-[10px] text-muted-foreground truncate leading-tight">
              {property?.suburb}{property?.postcode ? ` · ${property.postcode}` : ""}
              {property?.state ? ` · ${property.state}` : ""}
            </p>
          </div>
          {statusInfo && (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] shrink-0 hidden sm:inline-flex",
                statusInfo.cls.bg,
                statusInfo.cls.text,
                statusInfo.cls.border,
              )}
            >
              {statusInfo.label}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onToggleFavorite}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Star className={cn(
              "h-4 w-4",
              isFavorite ? "fill-amber-400 text-amber-500" : "text-muted-foreground"
            )} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onShare}
            title="Copy shareable link"
          >
            <Share2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Hero section ─────────────────────────────────────────────────────────

function PropertyHero({ property, listings, currentListing, currentAgent, currentAgency }) {
  const [lightboxIndex, setLightboxIndex] = useState(null);

  // Flatten all photos across all listings into a lightbox gallery.
  const allPhotos = useMemo(() => {
    const out = [];
    for (const l of listings) {
      const media = parseMediaItems(l);
      const photos = media.photos.length > 0
        ? media.photos.map((p) => p.url)
        : (l.hero_image ? [l.hero_image] : []);
      photos.forEach((url, i) => {
        if (!url) return;
        out.push({
          file_name: `${l.agency_name || "Listing"} — ${fmtDate(l.listed_date)} (${i + 1})`,
          file_url: url,
          file_type: "image/jpeg",
        });
      });
    }
    return out;
  }, [listings]);

  const latestVideo = useMemo(() => {
    for (const l of listings) {
      const media = parseMediaItems(l);
      if (media.video) return media.video;
    }
    return null;
  }, [listings]);

  const heroImage = property?.hero_image
    || currentListing?.hero_image
    || (allPhotos[0]?.file_url);

  // Price rendering via canonical helper
  const priceLabel = useMemo(() => {
    if (currentListing) {
      const dp = displayPrice(currentListing);
      return dp.label;
    }
    if (property?.latest_sold_price) {
      const n = Number(property.latest_sold_price);
      if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
      if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
      return `$${n}`;
    }
    return "Price on request";
  }, [currentListing, property]);

  const dateMessage = useMemo(() => {
    if (currentListing?.listing_type === "sold" && (currentListing.sold_date || property?.latest_sold_date)) {
      return `Sold ${fmtRelative(currentListing.sold_date || property.latest_sold_date)}`;
    }
    if (property?.latest_listed_date) {
      const days = property.days_on_market
        || Math.floor((Date.now() - new Date(property.latest_listed_date).getTime()) / 86400000);
      return `Listed ${days}d ago`;
    }
    if (property?.latest_sold_date) {
      return `Sold ${fmtRelative(property.latest_sold_date)}`;
    }
    return null;
  }, [currentListing, property]);

  const facts = [];
  if (property?.bedrooms) facts.push({ icon: Bed, val: property.bedrooms, key: "bed" });
  if (property?.bathrooms) facts.push({ icon: Bath, val: property.bathrooms, key: "bath" });
  if (property?.parking) facts.push({ icon: Car, val: property.parking, key: "car" });
  const landLabel = fmtLand(Number(property?.land_size_sqm) || null);

  const typeInfo = property?.current_listing_type
    ? {
      label: LISTING_TYPE_LABEL[property.current_listing_type] || property.current_listing_type,
      cls: listingTypeBadgeClasses(property.current_listing_type),
    }
    : null;

  return (
    <>
      <Card className="rounded-xl overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-5">
          {/* LEFT: cinematic image — 60% on desktop, full width on mobile */}
          <button
            type="button"
            onClick={() => allPhotos.length > 0 && setLightboxIndex(0)}
            disabled={allPhotos.length === 0}
            className={cn(
              "md:col-span-3 bg-muted overflow-hidden group relative block",
              "h-[40vh] md:h-[420px]",
              allPhotos.length > 0 && "cursor-pointer"
            )}
          >
            {heroImage ? (
              <img
                src={heroImage}
                alt={property?.display_address || ""}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                  e.currentTarget.parentElement.classList.add("flex", "items-center", "justify-center");
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                <Home className="h-16 w-16 opacity-30" />
              </div>
            )}
            {/* Chips — bottom-left */}
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
              {allPhotos.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-black/70 text-white text-[10px] sm:text-xs px-2 py-1 backdrop-blur">
                  <Images className="h-3 w-3" />
                  {allPhotos.length} photo{allPhotos.length !== 1 ? "s" : ""}
                </span>
              )}
              {latestVideo && (
                <span className="inline-flex items-center gap-1 rounded-full bg-black/70 text-white text-[10px] sm:text-xs px-2 py-1 backdrop-blur">
                  <Video className="h-3 w-3" />
                  Video
                </span>
              )}
            </div>
          </button>

          {/* RIGHT: facts + price + agent — 40% */}
          <div className="md:col-span-2 p-4 sm:p-5 flex flex-col gap-3 bg-background">
            <div className="flex items-center gap-2 flex-wrap">
              {typeInfo && (
                <Badge
                  variant="outline"
                  className={cn("text-[10px]", typeInfo.cls.bg, typeInfo.cls.text, typeInfo.cls.border)}
                >
                  {typeInfo.label}
                </Badge>
              )}
              {property?.property_type && (
                <Badge variant="outline" className="text-[10px] capitalize">
                  {property.property_type}
                </Badge>
              )}
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">
                {currentListing?.listing_type === "sold" ? "Sold Price" : "Price"}
              </p>
              <p className="text-[40px] leading-none font-bold tabular-nums text-foreground">
                {priceLabel}
              </p>
              {dateMessage && (
                <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {dateMessage}
                </p>
              )}
            </div>

            {(facts.length > 0 || landLabel) && (
              <div className="flex items-center gap-3 text-sm text-foreground flex-wrap">
                {facts.map((f) => (
                  <span key={f.key} className="flex items-center gap-1">
                    <f.icon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{f.val}</span>
                  </span>
                ))}
                {landLabel && (
                  <span className="flex items-center gap-1" title="Land size">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{landLabel}</span>
                  </span>
                )}
              </div>
            )}

            {/* Agent card — avatar, name, agency, rating, In CRM badge, call/email */}
            {(currentAgent || currentListing?.agent_name) && (
              <AgentCardInline
                agent={currentAgent}
                fallbackName={currentListing?.agent_name}
                fallbackAgency={currentListing?.agency_name}
              />
            )}
          </div>
        </div>
      </Card>

      {lightboxIndex !== null && allPhotos.length > 0 && (
        <AttachmentLightbox
          files={allPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

function AgentCardInline({ agent, fallbackName, fallbackAgency }) {
  const name = agent?.full_name || fallbackName || "Unknown agent";
  const agency = agent?.agency_name || fallbackAgency;
  const rating = agent?.rea_rating;
  const isInCrm = !!agent?.is_in_crm;
  const crmId = agent?.crm_agent_id;
  const pulseId = agent?.pulse_agent_id;

  const avatarContent = agent?.profile_image
    ? <AvatarImage src={agent.profile_image} alt={name} />
    : null;

  const nameLabel = (
    <>
      <p className="text-sm font-semibold truncate">{name}</p>
      {agency && (
        <p className="text-[11px] text-muted-foreground truncate">{agency}</p>
      )}
    </>
  );

  const wrappedName = (() => {
    if (crmId) {
      return (
        <Link
          to={createPageUrl("PersonDetails") + `?id=${crmId}`}
          className="min-w-0 hover:underline"
          title="Open in CRM"
        >
          {nameLabel}
        </Link>
      );
    }
    if (pulseId) {
      return (
        <Link
          to={`/IndustryPulse?tab=agents&pulse_id=${pulseId}`}
          className="min-w-0 hover:underline"
          title="Open in Industry Pulse"
        >
          {nameLabel}
        </Link>
      );
    }
    return <div className="min-w-0">{nameLabel}</div>;
  })();

  return (
    <div className="mt-auto border-t border-border pt-3">
      <div className="flex items-start gap-3">
        <Avatar className="h-10 w-10 shrink-0">
          {avatarContent}
          <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          {wrappedName}
          <div className="flex items-center gap-2 mt-1">
            {rating && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600">
                <Star className="h-2.5 w-2.5 fill-amber-400" />
                <span className="tabular-nums">{Number(rating).toFixed(1)}</span>
                {agent?.reviews_count ? (
                  <span className="text-muted-foreground">
                    ({agent.reviews_count})
                  </span>
                ) : null}
              </span>
            )}
            {isInCrm && (
              <Badge variant="outline" className="text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300">
                <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" /> In CRM
              </Badge>
            )}
          </div>
        </div>
      </div>
      {(agent?.mobile || agent?.email) && (
        <div className="flex items-center gap-2 mt-3">
          {agent?.mobile && (
            <a
              href={`tel:${agent.mobile}`}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted hover:bg-muted/80 transition-colors"
            >
              <Phone className="h-3 w-3" /> Call
            </a>
          )}
          {agent?.email && (
            <a
              href={`mailto:${agent.email}`}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted hover:bg-muted/80 transition-colors"
            >
              <Mail className="h-3 w-3" /> Email
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Signal ribbon — stacks banners ───────────────────────────────────────

function SignalRibbon({ signals, relistCandidate }) {
  // Convert relist_candidate into a synthetic signal at the top when present.
  const all = [];
  if (relistCandidate?.is_candidate) {
    all.push({
      _synthetic: true,
      signal_type: "relist_candidate",
      severity: "high",
      title: "Relist candidate",
      message: "Property was recently withdrawn and is active again — likely relist opportunity",
    });
  }
  for (const s of signals || []) all.push(s);
  if (all.length === 0) return null;

  return (
    <div className="space-y-2">
      {all.map((s, i) => (
        <SignalBanner key={s.id || `synth-${i}`} signal={s} />
      ))}
    </div>
  );
}

function SignalBanner({ signal }) {
  // Map signal_type → colour. Falls back to amber.
  const type = signal.signal_type || "";
  let cls = "border-amber-300 bg-amber-50/70 text-amber-900 dark:bg-amber-950/20 dark:text-amber-200";
  let Icon = AlertTriangle;
  if (type.includes("relist") || type.includes("withdrawal") || signal.severity === "high") {
    cls = "border-red-300 bg-red-50/70 text-red-900 dark:bg-red-950/20 dark:text-red-200";
    Icon = AlertTriangle;
  } else if (type.includes("auction")) {
    cls = "border-amber-300 bg-amber-50/70 text-amber-900 dark:bg-amber-950/20 dark:text-amber-200";
    Icon = Clock;
  } else if (type.includes("price_drop") || type.includes("price")) {
    cls = "border-blue-300 bg-blue-50/70 text-blue-900 dark:bg-blue-950/20 dark:text-blue-200";
    Icon = TrendingDown;
  }

  // Trim message to ~80 chars as spec'd
  const rawMsg = signal.message || signal.title || signal.signal_type || "Signal";
  const msg = rawMsg.length > 80 ? rawMsg.slice(0, 77) + "…" : rawMsg;

  return (
    <div className={cn("rounded-lg border px-3 py-2 flex items-center gap-2.5", cls)}>
      <Icon className="h-4 w-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs sm:text-sm font-medium truncate">{msg}</p>
      </div>
      {/* Action button — deferred to Phase 2 per spec */}
      <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" disabled title="Action coming in Phase 2">
        Action
      </Button>
    </div>
  );
}

// ── Price Timeline Chart (Phase 2) ──────────────────────────────────────
//
// Composed chart that overlays:
//   • a line tracking `asking_price` across all listings (nulls bridged)
//   • dots for new-listing / sold / withdrawn events
//   • square markers for FlexMedia shoot dates
//   • ReferenceArea bands covering FlexMedia shoot windows
//
// Click a dot → scrolls Timeline tab into view and flash-highlights the
// matching event card (parent wires this via `onDotClick(eventId)`).
//
// Safety: dates parsed defensively with `resolveListedDate`. Charts with
// 0 plottable points return null so the parent skips rendering.

function resolveListedDate(listing) {
  const candidates = [
    listing.listed_date,
    listing.first_seen_at,
    listing.created_at,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (isFinite(t)) return t;
  }
  return null;
}

function resolveDate(raw) {
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return isFinite(t) ? t : null;
}

function formatPriceShort(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

function PriceTimelineTooltip({ active, payload, compact }) {
  if (!active || !payload || payload.length === 0) return null;
  // Prefer the scatter (event) payload over the line when both match
  const scatterP = payload.find((p) => p.payload?._meta);
  const linePoint = payload.find((p) => p.dataKey === "asking");
  const meta = scatterP?.payload?._meta || linePoint?.payload?._meta || null;
  const dateMs = scatterP?.payload?.x ?? linePoint?.payload?.x;
  const price = scatterP?.payload?.y ?? linePoint?.payload?.asking;
  const kind = meta?.kind;
  const KIND_LABEL = {
    listed: "New listing",
    sold: "Sold",
    withdrawn: "Withdrawn",
    shoot: "FlexStudios shoot",
  };
  const kindColor = {
    listed: "text-blue-600",
    sold: "text-emerald-600",
    withdrawn: "text-amber-600",
    shoot: "text-violet-600",
  }[kind] || "text-muted-foreground";

  return (
    <div className="bg-popover border border-border rounded-md shadow-md p-2 max-w-[220px]">
      <div className="flex items-start gap-2">
        {!compact && meta?.heroImage && (
          <img
            src={meta.heroImage}
            alt=""
            className="h-10 w-14 object-cover rounded shrink-0"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        )}
        <div className="flex-1 min-w-0">
          {kind && (
            <p className={cn("text-[10px] uppercase tracking-widest font-bold", kindColor)}>
              {KIND_LABEL[kind] || kind}
            </p>
          )}
          <p className="text-xs font-bold tabular-nums">
            {formatPriceShort(price)}
          </p>
          {dateMs && (
            <p className="text-[10px] text-muted-foreground">{fmtDate(dateMs)}</p>
          )}
          {!compact && meta?.agent && (
            <p className="text-[10px] text-muted-foreground truncate">{meta.agent}</p>
          )}
          {!compact && meta?.agency && (
            <p className="text-[10px] text-muted-foreground truncate">{meta.agency}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PriceTimelineChart({ listings, projects, onDotClick }) {
  const isMobile = useIsMobile();
  const chartHeight = isMobile ? 140 : 220;

  // ── Build line data: one point per listing with a resolvable date ──
  const lineData = useMemo(() => {
    const points = [];
    for (const l of (listings || [])) {
      const ms = resolveListedDate(l);
      if (ms == null) continue;
      const price = Number(l.asking_price);
      points.push({
        x: ms,
        asking: isFinite(price) && price > 0 ? price : null,
        _meta: {
          kind: "listed",
          heroImage: l.hero_image,
          agent: l.agent_name,
          agency: l.agency_name,
          listing_id: l.id,
        },
      });
    }
    return points.sort((a, b) => a.x - b.x);
  }, [listings]);

  // ── Build scatter datasets: listed / sold / withdrawn / shoot ──
  const { listedPoints, soldPoints, withdrawnPoints, shootPoints } = useMemo(() => {
    const listed = [];
    const sold = [];
    const withdrawn = [];
    const shoots = [];
    for (const l of (listings || [])) {
      const listedMs = resolveListedDate(l);
      const listedPrice = Number(l.asking_price);
      if (listedMs != null && isFinite(listedPrice) && listedPrice > 0) {
        listed.push({
          x: listedMs, y: listedPrice,
          _meta: {
            kind: "listed", heroImage: l.hero_image,
            agent: l.agent_name, agency: l.agency_name,
            eventId: `listed-${l.id}`,
          },
        });
      }
      const soldMs = resolveDate(l.sold_date);
      const soldPrice = Number(l.sold_price);
      if (soldMs != null && isFinite(soldPrice) && soldPrice > 0) {
        sold.push({
          x: soldMs, y: soldPrice,
          _meta: {
            kind: "sold", heroImage: l.hero_image,
            agent: l.agent_name, agency: l.agency_name,
            eventId: `sold-${l.id}`,
          },
        });
      }
      const wdMs = resolveDate(l.listing_withdrawn_at);
      if (wdMs != null) {
        // Y-value: fall back to asking price; if missing, interpolate later
        const wdPrice = isFinite(listedPrice) && listedPrice > 0 ? listedPrice : null;
        if (wdPrice != null) {
          withdrawn.push({
            x: wdMs, y: wdPrice,
            _meta: {
              kind: "withdrawn", heroImage: l.hero_image,
              agent: l.agent_name, agency: l.agency_name,
              eventId: `withdrawn-${l.id}`,
            },
          });
        }
      }
    }
    for (const p of (projects || [])) {
      const shootMs = resolveDate(p.shoot_date || p.booking_date || p.created_at);
      if (shootMs == null) continue;
      // Interpolate Y from line data (nearest asking price)
      let y = null;
      if (lineData.length > 0) {
        const nearest = lineData
          .filter((pt) => pt.asking != null)
          .reduce((best, pt) => {
            const d = Math.abs(pt.x - shootMs);
            if (!best || d < best.d) return { d, y: pt.asking };
            return best;
          }, null);
        y = nearest?.y ?? null;
      }
      shoots.push({
        x: shootMs, y: y ?? 0,
        _meta: {
          kind: "shoot",
          agent: p.agent_name || p.project_owner_name,
          agency: p.agency_name,
          eventId: `shoot-${p.id}`,
        },
      });
    }
    return {
      listedPoints: listed,
      soldPoints: sold,
      withdrawnPoints: withdrawn,
      shootPoints: shoots,
    };
  }, [listings, projects, lineData]);

  // ── FlexMedia shade bands (±2 days around each shoot) ──
  const shootBands = useMemo(() => {
    const DAY = 86400000;
    return shootPoints.map((s) => ({
      x1: s.x - 2 * DAY,
      x2: s.x + 2 * DAY,
    }));
  }, [shootPoints]);

  // Total plottable points — dictates render path
  const totalPoints = lineData.length
    + soldPoints.length
    + withdrawnPoints.length
    + shootPoints.length;

  // 0 points → hide entirely
  if (totalPoints === 0) return null;

  // Determine domain
  const allTimes = [
    ...lineData.map((p) => p.x),
    ...soldPoints.map((p) => p.x),
    ...withdrawnPoints.map((p) => p.x),
    ...shootPoints.map((p) => p.x),
  ];
  const xMin = Math.min(...allTimes);
  const xMax = Math.max(...allTimes);
  const xPadding = Math.max((xMax - xMin) * 0.05, 86400000 * 7); // ≥ 1 week
  const xDomain = xMin === xMax
    ? [xMin - 30 * 86400000, xMax + 30 * 86400000]
    : [xMin - xPadding, xMax + xPadding];

  // 1 point → sparkline empty-ish state with helper copy
  if (totalPoints < 2) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Price Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ height: chartHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={lineData.length > 0 ? lineData : listedPoints}
                margin={{ top: 8, right: 12, left: 4, bottom: 4 }}
              >
                <XAxis
                  dataKey="x" type="number" scale="time" domain={xDomain}
                  tickFormatter={(v) => fmtMonthYear(v)}
                  tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3}
                />
                <YAxis
                  tickFormatter={(v) => "$" + (v / 1_000_000).toFixed(1) + "M"}
                  tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3}
                  width={48}
                />
                <Scatter
                  data={lineData.length > 0 ? lineData.filter((p) => p.asking != null) : listedPoints}
                  dataKey={lineData.length > 0 ? "asking" : "y"}
                  fill="#3b82f6"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] text-muted-foreground text-center mt-1">
            Only 1 listing — more data will populate as new listings appear.
          </p>
        </CardContent>
      </Card>
    );
  }

  const handleScatterClick = (pt) => {
    const eid = pt?.payload?._meta?.eventId || pt?._meta?.eventId;
    if (eid) onDotClick?.(eid);
  };

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Price Timeline
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">
            {lineData.length} listing{lineData.length !== 1 ? "s" : ""}
            {shootPoints.length > 0 && ` · ${shootPoints.length} shoot${shootPoints.length !== 1 ? "s" : ""}`}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div style={{ height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              margin={{ top: 8, right: 12, left: 4, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} />
              <XAxis
                dataKey="x" type="number" scale="time" domain={xDomain}
                tickFormatter={(v) => fmtMonthYear(v)}
                tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3}
                allowDuplicatedCategory={false}
              />
              <YAxis
                type="number" dataKey="y"
                tickFormatter={(v) => "$" + (v / 1_000_000).toFixed(1) + "M"}
                tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3}
                width={48}
                domain={["auto", "auto"]}
              />
              {shootBands.map((b, i) => (
                <ReferenceArea
                  key={`band-${i}`}
                  x1={b.x1} x2={b.x2}
                  fill="#8b5cf6" fillOpacity={0.08}
                  stroke="#8b5cf6" strokeOpacity={0.15}
                  ifOverflow="extendDomain"
                />
              ))}
              <RTooltip
                content={<PriceTimelineTooltip compact={isMobile} />}
                cursor={{ strokeDasharray: "3 3", strokeOpacity: 0.3 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                iconSize={8}
              />
              <Line
                name="Asking price"
                data={lineData}
                dataKey="asking"
                type="monotone"
                stroke="#64748b"
                strokeWidth={1.5}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              <Scatter
                name="New listing"
                data={listedPoints}
                fill="#3b82f6"
                shape="circle"
                onClick={handleScatterClick}
                isAnimationActive={false}
              />
              <Scatter
                name="Sold"
                data={soldPoints}
                fill="#10b981"
                shape="circle"
                onClick={handleScatterClick}
                isAnimationActive={false}
              />
              <Scatter
                name="Withdrawn"
                data={withdrawnPoints}
                fill="#f59e0b"
                shape="circle"
                onClick={handleScatterClick}
                isAnimationActive={false}
              />
              <Scatter
                name="FlexMedia shoot"
                data={shootPoints}
                fill="#8b5cf6"
                shape="square"
                onClick={handleScatterClick}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Intelligence strip — 7 tiles ─────────────────────────────────────────

function IntelligenceStrip({ property, listings, projects, onTileClick }) {
  // Compute tiles
  const listingsCount = listings.length;

  const avgDom = useMemo(() => {
    const doms = listings
      .map((l) => Number(l.days_on_market) || 0)
      .filter((n) => n > 0);
    if (doms.length === 0) return null;
    return Math.round(doms.reduce((a, b) => a + b, 0) / doms.length);
  }, [listings]);

  const withdrawalCount = useMemo(
    () => listings.filter((l) => !!l.listing_withdrawn_at).length,
    [listings],
  );

  // Price Δ: latest non-null asking_price vs previous
  const priceDelta = useMemo(() => {
    const priced = listings
      .filter((l) => l.asking_price && l.listed_date)
      .sort((a, b) => new Date(b.listed_date) - new Date(a.listed_date));
    if (priced.length < 2) return null;
    const a = Number(priced[0].asking_price);
    const b = Number(priced[1].asking_price);
    if (!a || !b) return null;
    const pct = ((a - b) / b) * 100;
    return { pct, direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
  }, [listings]);

  const lastSoldLabel = useMemo(() => {
    if (property?.latest_sold_price) {
      const n = Number(property.latest_sold_price);
      if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
      if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
      return `$${n}`;
    }
    return "—";
  }, [property]);

  const projectsCount = projects.length;

  // Heat: quick composite — freshness + withdrawals + signals density (proxy)
  const heat = useMemo(() => {
    let score = 0;
    if (property?.current_listing_type) score += 40;
    if (withdrawalCount > 0) score += 15 * withdrawalCount;
    if (property?.days_on_market && property.days_on_market < 14) score += 20;
    if (projectsCount > 0) score += 10 * Math.min(projectsCount, 3);
    return Math.min(score, 100);
  }, [property, withdrawalCount, projectsCount]);

  const tiles = [
    {
      key: "listings", label: "Listings", value: listingsCount,
      Icon: Building2, color: "text-blue-600", tab: "timeline",
    },
    {
      key: "dom", label: "Avg DoM", value: avgDom == null ? "—" : `${avgDom}d`,
      Icon: Clock, color: "text-indigo-600", tab: "timeline",
    },
    {
      key: "withdrawals", label: "Withdrawals",
      value: withdrawalCount, color: withdrawalCount > 0 ? "text-red-600" : "text-muted-foreground",
      Icon: TrendingDown, tab: "timeline",
    },
    {
      key: "delta", label: "Price Δ",
      value: priceDelta == null ? "—" : `${priceDelta.pct > 0 ? "+" : ""}${priceDelta.pct.toFixed(1)}%`,
      Icon: priceDelta?.direction === "down" ? TrendingDown : TrendingUp,
      color: priceDelta?.direction === "down" ? "text-red-600"
        : priceDelta?.direction === "up" ? "text-emerald-600" : "text-muted-foreground",
      tab: "timeline",
    },
    {
      key: "sold", label: "Last Sold",
      value: lastSoldLabel,
      Icon: DollarSign,
      color: "text-emerald-600",
      tab: "timeline",
    },
    {
      key: "projects", label: "Projects", value: projectsCount,
      Icon: Camera, color: "text-violet-600", tab: "projects",
    },
    {
      key: "heat", label: "Heat",
      value: heat === 0 ? "—" : `${heat}`,
      Icon: TrendingUp,
      color: heat >= 60 ? "text-red-500" : heat >= 30 ? "text-amber-500" : "text-muted-foreground",
      tab: "timeline",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
      {tiles.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onTileClick(t.tab)}
          className="text-left rounded-xl border border-border bg-card p-2.5 hover:bg-muted/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex items-center gap-1.5 mb-1.5">
            <t.Icon className={cn("h-3.5 w-3.5", t.color)} />
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t.label}
            </span>
          </div>
          <p className={cn("text-lg font-bold tabular-nums leading-none", t.color)}>
            {typeof t.value === "number" ? t.value.toLocaleString() : t.value}
          </p>
        </button>
      ))}
    </div>
  );
}

// ── Timeline tab ─────────────────────────────────────────────────────────

function TimelineTab({ events, listings, projects, flashedEventId }) {
  const [filter, setFilter] = useState("all"); // all | shoots | rea | sales

  // Normalize events — rpc returns pulse_timeline rows, but fall back to
  // synthesizing from listings + projects when the RPC shape is empty.
  // Each item gets a stable `_id` so PriceTimelineChart can flash-link to it.
  const allItems = useMemo(() => {
    if (Array.isArray(events) && events.length > 0) {
      return events.map((e, i) => ({
        ...e,
        _kind: classifyEventKind(e),
        _date: e.event_date || e.occurred_at || e.created_at,
        _id: e.id || `evt-${i}`,
      })).filter((e) => e._date);
    }
    // Fallback — synthesize from listings & projects
    const synth = [];
    for (const l of listings) {
      if (l.listed_date) {
        synth.push({
          _id: `listed-${l.id}`,
          _kind: "rea", _date: l.listed_date,
          title: `${LISTING_TYPE_LABEL[l.listing_type] || l.listing_type} — ${displayPrice(l).label}`,
          subtitle: `${l.agent_name || "—"} · ${l.agency_name || "—"}`,
          listing_id: l.id, source_url: l.source_url,
        });
      }
      if (l.sold_date && l.sold_price) {
        synth.push({
          _id: `sold-${l.id}`,
          _kind: "sale", _date: l.sold_date,
          title: `Sold ${displayPrice({ ...l, listing_type: "sold" }).label}`,
          subtitle: `${l.agent_name || "—"} · ${l.agency_name || "—"}`,
          listing_id: l.id, source_url: l.source_url,
        });
      }
      if (l.listing_withdrawn_at) {
        synth.push({
          _id: `withdrawn-${l.id}`,
          _kind: "rea", _date: l.listing_withdrawn_at,
          title: "Listing withdrawn",
          subtitle: `${l.agent_name || "—"} · ${l.agency_name || "—"}`,
          listing_id: l.id, source_url: l.source_url,
        });
      }
    }
    for (const p of projects) {
      const d = p.shoot_date || p.created_at || p.booking_date;
      if (d) {
        synth.push({
          _id: `shoot-${p.id}`,
          _kind: "shoot", _date: d,
          title: `FlexStudios shoot — ${p.tonomo_package || p.package_name || "Project"}`,
          subtitle: `${p.agent_name || p.project_owner_name || ""}`,
          project_id: p.id,
        });
      }
    }
    return synth.sort((a, b) => new Date(b._date) - new Date(a._date));
  }, [events, listings, projects]);

  const filtered = useMemo(() => {
    if (filter === "all") return allItems;
    if (filter === "shoots") return allItems.filter((e) => e._kind === "shoot");
    if (filter === "rea") return allItems.filter((e) => e._kind === "rea");
    if (filter === "sales") return allItems.filter((e) => e._kind === "sale");
    return allItems;
  }, [allItems, filter]);

  // Group by month
  const grouped = useMemo(() => {
    const map = new Map();
    for (const e of filtered) {
      const key = fmtMonthYear(e._date);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4" />
            Property Timeline
            <Badge variant="outline" className="text-[10px]">
              {filtered.length} event{filtered.length !== 1 ? "s" : ""}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-1 flex-wrap">
            {[
              { value: "all", label: "All" },
              { value: "shoots", label: "Our shoots" },
              { value: "rea", label: "REA events" },
              { value: "sales", label: "Sales" },
            ].map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  "text-[10px] px-2 py-1 rounded-md transition-colors",
                  filter === f.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {grouped.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            No events match the current filter.
          </p>
        ) : grouped.map(([month, items]) => (
          <div key={month}>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                {month}
              </p>
              <div className="flex-1 border-t border-border/60"></div>
              <span className="text-[10px] text-muted-foreground/70">
                {items.length} event{items.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="space-y-2 ml-2 border-l-2 border-border/40 pl-4">
              {items.map((e, i) => (
                <TimelineCard
                  key={e._id || e.id || `${month}-${i}`}
                  event={e}
                  flashed={flashedEventId && flashedEventId === e._id}
                />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function classifyEventKind(e) {
  const t = String(e.event_type || "").toLowerCase();
  if (t.includes("shoot") || t.includes("project") || t.includes("booking") || t.includes("delivered")) return "shoot";
  if (t.includes("sold") || t.includes("sale")) return "sale";
  if (t.includes("list") || t.includes("withdraw") || t.includes("price") || t.includes("auction")) return "rea";
  return "rea";
}

function TimelineCard({ event, flashed }) {
  const kind = event._kind;
  // Flash ring appears briefly when the Price Timeline Chart targets this card.
  const flashCls = flashed
    ? "ring-2 ring-primary ring-offset-2 ring-offset-background transition-shadow"
    : "transition-shadow";

  if (kind === "shoot") {
    const content = (
      <div className={cn(
        "bg-violet-50/40 dark:bg-violet-950/20 border border-violet-200/60 dark:border-violet-800/40 rounded p-2",
        flashCls,
      )}>
        <div className="flex items-start gap-2">
          <Camera className="h-3.5 w-3.5 text-violet-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium">{event.title || "FlexStudios shoot"}</p>
            {event.subtitle && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{event.subtitle}</p>
            )}
            <p className="text-[10px] text-muted-foreground/80 mt-0.5">{fmtDate(event._date)}</p>
          </div>
        </div>
      </div>
    );
    if (event.project_id) {
      return (
        <Link to={createPageUrl(`ProjectDetails?id=${event.project_id}`)} className="block hover:opacity-90">
          {content}
        </Link>
      );
    }
    return content;
  }

  if (kind === "sale") {
    return (
      <div className={cn(
        "bg-emerald-50/40 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/40 rounded p-2",
        flashCls,
      )}>
        <div className="flex items-start gap-2">
          <DollarSign className="h-3.5 w-3.5 text-emerald-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold">{event.title || "Sold"}</p>
            {event.subtitle && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{event.subtitle}</p>
            )}
            <p className="text-[10px] text-muted-foreground/80 mt-0.5">{fmtDate(event._date)}</p>
          </div>
          {event.source_url && (
            <a
              href={event.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-600 hover:text-emerald-700"
              title="Open on REA"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    );
  }

  // Default REA event
  return (
    <div className={cn("bg-muted/40 border border-border/60 rounded p-2", flashCls)}>
      <div className="flex items-start gap-2">
        <Building2 className="h-3.5 w-3.5 text-blue-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium">{event.title || event.event_type || "Listing"}</p>
          {event.subtitle && (
            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{event.subtitle}</p>
          )}
          <p className="text-[10px] text-muted-foreground/80 mt-0.5">{fmtDate(event._date)}</p>
        </div>
        {event.source_url && (
          <a
            href={event.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-700"
            title="Open on REA"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

// ── Media tab ────────────────────────────────────────────────────────────

function MediaTab({ listings }) {
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [visibleCount, setVisibleCount] = useState(40);

  // Aggregate photos / floorplans / video across all listings
  const { allPhotos, allFloorplans, allVideos } = useMemo(() => {
    const photos = [];
    const fps = [];
    const vids = [];
    for (const l of listings) {
      const media = parseMediaItems(l);
      const listPhotos = media.photos.length > 0
        ? media.photos.map((p) => p.url)
        : (l.hero_image ? [l.hero_image] : []);
      listPhotos.forEach((url, i) => {
        if (!url) return;
        photos.push({
          file_name: `${l.agency_name || "Listing"} — ${fmtDate(l.listed_date)} (${i + 1})`,
          file_url: url,
          file_type: "image/jpeg",
          _agency: l.agency_name,
          _date: l.listed_date,
        });
      });
      for (const fp of media.floorplans) {
        fps.push({ ...fp, _agency: l.agency_name, _date: l.listed_date });
      }
      if (media.video) {
        vids.push({ ...media.video, _agency: l.agency_name, _date: l.listed_date });
      }
    }
    return { allPhotos: photos, allFloorplans: fps, allVideos: vids };
  }, [listings]);

  const visiblePhotos = allPhotos.slice(0, visibleCount);

  if (allPhotos.length === 0 && allFloorplans.length === 0 && allVideos.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-10 text-center">
          <Images className="h-10 w-10 mx-auto mb-2 opacity-30 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No media yet for this property.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {allPhotos.length > 0 && (
        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Images className="h-4 w-4 text-blue-600" />
              Photos
              <Badge variant="outline" className="text-[10px]">{allPhotos.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1.5">
              {visiblePhotos.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  className="aspect-square overflow-hidden rounded-md bg-muted group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <img
                    src={p.file_url}
                    alt={p.file_name}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                    onError={(e) => { e.currentTarget.style.opacity = 0.3; }}
                  />
                </button>
              ))}
            </div>
            {allPhotos.length > visibleCount && (
              <div className="text-center mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setVisibleCount((n) => n + 40)}
                >
                  Load more ({allPhotos.length - visibleCount} remaining)
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {allFloorplans.length > 0 && (
        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <FileText className="h-4 w-4 text-indigo-600" />
              Floorplans
              <Badge variant="outline" className="text-[10px]">{allFloorplans.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {allFloorplans.map((fp, i) => (
                <a
                  key={i}
                  href={fp.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block group"
                  title={fp._agency || "Floorplan"}
                >
                  <img
                    src={fp.thumb || fp.url}
                    alt={`Floorplan ${i + 1}`}
                    className="h-24 w-32 object-contain rounded border border-border bg-white group-hover:shadow-md transition-shadow"
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {allVideos.length > 0 && (
        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Video className="h-4 w-4 text-red-600" />
              Videos
              <Badge variant="outline" className="text-[10px]">{allVideos.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {allVideos.map((v, i) => {
              const yt = v.url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([A-Za-z0-9_-]{11})/);
              if (yt) {
                return (
                  <iframe
                    key={i}
                    src={`https://www.youtube.com/embed/${yt[1]}`}
                    title="Listing video"
                    className="w-full max-w-lg aspect-video rounded border border-border"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                );
              }
              return (
                <a
                  key={i}
                  href={v.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <Play className="h-3.5 w-3.5" />
                  Watch video
                  <ExternalLink className="h-3 w-3" />
                </a>
              );
            })}
          </CardContent>
        </Card>
      )}

      {lightboxIndex !== null && (
        <AttachmentLightbox
          files={allPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

// ── Projects tab ─────────────────────────────────────────────────────────

function ProjectsTab({ projects, property }) {
  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Camera className="h-4 w-4 text-violet-600" />
            FlexStudios Projects
            <Badge variant="outline" className="text-[10px]">{projects.length}</Badge>
          </CardTitle>
          <Link to={`/ProjectDetails?id=new&address=${encodeURIComponent(property?.display_address || "")}`}>
            <Button variant="outline" size="sm" className="h-7 text-xs">
              + New project
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {projects.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            No shoots at this property yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {projects.map((p) => (
              <Link
                key={p.id}
                to={createPageUrl(`ProjectDetails?id=${p.id}`)}
                className="block p-2.5 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-xs font-semibold truncate flex-1">
                    {p.tonomo_package || p.package_name || "Project"}
                  </p>
                  {p.status && (
                    <Badge variant="outline" className="text-[9px] shrink-0 capitalize">
                      {String(p.status).replace(/_/g, " ")}
                    </Badge>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground truncate">
                  {p.agent_name || p.project_owner_name || "—"}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {fmtDate(p.shoot_date || p.booking_date || p.created_at)}
                  {p.photographer_name && <> · {p.photographer_name}</>}
                </p>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Agents tab ───────────────────────────────────────────────────────────

function AgentsTab({ agents, agencies }) {
  if (!agents || agents.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-10 text-center">
          <Users className="h-10 w-10 mx-auto mb-2 opacity-30 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No agents detected at this property.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Users className="h-4 w-4 text-blue-600" />
          Agents
          <Badge variant="outline" className="text-[10px]">{agents.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 border-y border-border">
              <tr className="text-left">
                <th className="px-3 py-2 font-semibold">Agent</th>
                <th className="px-3 py-2 font-semibold hidden sm:table-cell">Agency</th>
                <th className="px-3 py-2 font-semibold text-right">Campaigns</th>
                <th className="px-3 py-2 font-semibold hidden md:table-cell">Latest</th>
                <th className="px-3 py-2 font-semibold text-right hidden lg:table-cell">Avg DoM</th>
                <th className="px-3 py-2 font-semibold text-right hidden lg:table-cell">Sales (lead)</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const nameLabel = (
                  <div className="flex items-center gap-2 min-w-0">
                    <Avatar className="h-7 w-7 shrink-0">
                      {a.profile_image && <AvatarImage src={a.profile_image} alt={a.full_name} />}
                      <AvatarFallback className="text-[10px]">{initials(a.full_name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{a.full_name || "—"}</p>
                      {a.job_title && (
                        <p className="text-[10px] text-muted-foreground truncate">{a.job_title}</p>
                      )}
                    </div>
                    {a.is_in_crm && (
                      <Badge variant="outline" className="text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0">
                        CRM
                      </Badge>
                    )}
                  </div>
                );
                const wrapped = a.crm_agent_id
                  ? (
                    <Link
                      to={createPageUrl("PersonDetails") + `?id=${a.crm_agent_id}`}
                      className="hover:underline"
                      title="Open CRM record"
                    >
                      {nameLabel}
                    </Link>
                  )
                  : a.pulse_agent_id
                  ? (
                    <Link
                      to={`/IndustryPulse?tab=agents&pulse_id=${a.pulse_agent_id}`}
                      className="hover:underline"
                      title="Open Industry Pulse record"
                    >
                      {nameLabel}
                    </Link>
                  )
                  : nameLabel;
                return (
                  <tr key={a.rea_agent_id || a.pulse_agent_id || a.full_name} className="border-t border-border/60 hover:bg-muted/30">
                    <td className="px-3 py-2">{wrapped}</td>
                    <td className="px-3 py-2 hidden sm:table-cell truncate max-w-[180px]">
                      {a.agency_name || "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {a.campaigns_count != null ? a.campaigns_count : "—"}
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell">
                      {fmtDate(a.latest_campaign_date)}
                    </td>
                    <td className="px-3 py-2 text-right hidden lg:table-cell tabular-nums">
                      {a.avg_days_on_market != null ? `${Math.round(a.avg_days_on_market)}d` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right hidden lg:table-cell tabular-nums">
                      {a.sales_as_lead != null ? a.sales_as_lead : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Right-rail cards ─────────────────────────────────────────────────────

function CurrentlyListedByCard({ agency, agent, listing }) {
  const brandAccent = hexToRgba(agency?.brand_color_primary, 1);
  const brandTint = hexToRgba(agency?.brand_color_primary, 0.06);
  const headerStyle = brandAccent
    ? { borderTop: `3px solid ${brandAccent}`, backgroundColor: brandTint }
    : undefined;

  const agencyName = agency?.name || listing?.agency_name || "Unknown agency";
  const crmAgencyId = agency?.crm_agency_id;
  const pulseAgencyId = agency?.pulse_agency_id;

  const title = (
    <div className="flex items-center gap-2">
      {agency?.logo_url ? (
        <div className="h-9 w-9 rounded-full bg-white border border-border shrink-0 overflow-hidden flex items-center justify-center">
          <img
            src={agency.logo_url}
            alt={agencyName}
            className="max-w-full max-h-full object-contain"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        </div>
      ) : (
        <div className="h-9 w-9 rounded-full bg-muted shrink-0 flex items-center justify-center">
          <Building2 className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-tight">
          Currently listed by
        </p>
        <p className="text-sm font-semibold truncate leading-tight">{agencyName}</p>
      </div>
    </div>
  );

  const wrappedTitle = crmAgencyId
    ? <Link to={createPageUrl("OrgDetails") + `?id=${crmAgencyId}`} className="hover:underline">{title}</Link>
    : pulseAgencyId
    ? <Link to={`/IndustryPulse?tab=agencies&pulse_id=${pulseAgencyId}`} className="hover:underline">{title}</Link>
    : title;

  return (
    <Card className="rounded-xl overflow-hidden">
      <div className="p-3" style={headerStyle}>
        {wrappedTitle}
      </div>
      <CardContent className="p-3 pt-2 space-y-2">
        {agent?.full_name && (
          <div className="flex items-center gap-2">
            <Avatar className="h-8 w-8 shrink-0">
              {agent.profile_image && <AvatarImage src={agent.profile_image} alt={agent.full_name} />}
              <AvatarFallback className="text-[10px]">{initials(agent.full_name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{agent.full_name}</p>
              {agent.job_title && (
                <p className="text-[10px] text-muted-foreground truncate">{agent.job_title}</p>
              )}
            </div>
            {agent.is_in_crm && (
              <Badge variant="outline" className="text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0">
                CRM
              </Badge>
            )}
          </div>
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
          {agency?.phone && (
            <a
              href={`tel:${agency.phone}`}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted hover:bg-muted/80"
            >
              <Phone className="h-3 w-3" /> Phone
            </a>
          )}
          {agency?.email && (
            <a
              href={`mailto:${agency.email}`}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted hover:bg-muted/80"
            >
              <Mail className="h-3 w-3" /> Email
            </a>
          )}
          {agency?.website && (
            <a
              href={agency.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-muted hover:bg-muted/80"
            >
              <ExternalLink className="h-3 w-3" /> Site
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NextEventCard({ upcoming }) {
  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5" />
          Next event
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {upcoming.map((e, i) => {
          const isAuction = String(e.kind || e.event_type || "").toLowerCase().includes("auction");
          const isOpenHouse = String(e.kind || e.event_type || "").toLowerCase().includes("inspect")
            || String(e.kind || e.event_type || "").toLowerCase().includes("open");
          const label = isAuction ? "Auction" : isOpenHouse ? "Open house" : (e.title || e.event_type || "Event");
          const Icon = isAuction ? Tag : Calendar;
          const when = e.event_date
            ? (isAuction ? formatAuctionDateTime(e.event_date, e.time_known) : fmtDate(e.event_date))
            : "—";
          return (
            <div key={i} className="flex items-start gap-2">
              <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", isAuction ? "text-amber-600" : "text-blue-600")} />
              <div className="min-w-0">
                <p className="text-xs font-medium">{label}</p>
                <p className="text-[10px] text-muted-foreground">{when}</p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function OurHistoryCard({ projects }) {
  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
          <Camera className="h-3.5 w-3.5 text-violet-600" />
          Our history here
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {projects.map((p) => (
          <Link
            key={p.id}
            to={createPageUrl(`ProjectDetails?id=${p.id}`)}
            className="block hover:bg-muted/40 rounded p-1.5 -mx-1.5 transition-colors"
          >
            <div className="flex items-start gap-2">
              <Camera className="h-3 w-3 text-violet-600 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium truncate">
                  {p.tonomo_package || p.package_name || "Project"}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {fmtDate(p.shoot_date || p.booking_date || p.created_at)}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Market tab ───────────────────────────────────────────────────────────
//
// Phase 2. Three stacked sections:
//   1. Comparable sales   — dossier.comparables (≤5 sold in same suburb,
//                            ±1 bed, last 12mo — already ranked by the RPC).
//   2. Nearby FlexMedia clients — dossier.neighbour_clients (≤5 CRM agents
//                            active in the same suburb).
//   3. Suburb median snapshot — live query of sold prices in the last 90
//                            days for this suburb; renders a median tile.
//
// Mobile layout: comparables go 1-up, neighbours stack, median tile is
// full-width. All three sections stack vertically on every breakpoint.
function MarketTab({ comparables, neighbours, suburb }) {
  const suburbLabel = suburb || "this suburb";

  // Live suburb median (last 90 days) — independent of the dossier so it's
  // always fresh even if the RPC is cached.
  const { data: medianRows, isLoading: medianLoading } = useQuery({
    queryKey: ["suburb-sold-median-90d", suburb],
    enabled: !!suburb,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data, error } = await api._supabase
        .from("pulse_listings")
        .select("sold_price, sold_date")
        .eq("suburb", suburb)
        .eq("listing_type", "sold")
        .gte("sold_date", cutoff)
        .not("sold_price", "is", null);
      if (error) throw error;
      return data || [];
    },
  });

  const medianStat = useMemo(() => {
    const prices = (medianRows || [])
      .map((r) => Number(r.sold_price))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (prices.length === 0) return null;
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;
    return { median, n: prices.length };
  }, [medianRows]);

  return (
    <div className="space-y-3">
      {/* ── Section 1: Comparable sales ─────────────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-emerald-600" />
            Comparable sales
            {comparables.length > 0 && (
              <Badge variant="outline" className="text-[10px]">{comparables.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {comparables.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No comparable sales found in {suburbLabel} for similar properties in the last 12 months.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {comparables.slice(0, 5).map((c, i) => {
                const priceLabel = c.sold_price
                  ? `$${(Number(c.sold_price) / 1_000_000).toFixed(2)}M`
                  : "—";
                const href = c.property_key
                  ? createPageUrl("PropertyDetails") + `?key=${c.property_key}`
                  : null;
                const card = (
                  <div className="rounded-xl border border-border overflow-hidden bg-card hover:shadow-md hover:border-emerald-300 transition-all h-full flex flex-col">
                    <div className="aspect-[16/10] bg-muted overflow-hidden">
                      {c.hero_image ? (
                        <img
                          src={c.hero_image}
                          alt={c.address || "Comparable"}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                          <Home className="h-8 w-8 opacity-40" />
                        </div>
                      )}
                    </div>
                    <div className="p-3 flex-1 flex flex-col">
                      <p className="text-xl font-bold tabular-nums text-emerald-700 leading-none">
                        {priceLabel}
                      </p>
                      <p className="text-xs font-medium mt-1.5 line-clamp-2">
                        {c.address || "—"}
                      </p>
                      {c.suburb && (
                        <p className="text-[11px] text-muted-foreground">{c.suburb}</p>
                      )}
                      {(c.bedrooms != null || c.bathrooms != null || c.car_spaces != null) && (
                        <div className="flex items-center gap-2 mt-2 text-[11px] text-muted-foreground tabular-nums">
                          {c.bedrooms != null && (
                            <span className="flex items-center gap-0.5">
                              <Bed className="h-3 w-3" />{c.bedrooms}
                            </span>
                          )}
                          {c.bathrooms != null && (
                            <span className="flex items-center gap-0.5">
                              <Bath className="h-3 w-3" />{c.bathrooms}
                            </span>
                          )}
                          {c.car_spaces != null && (
                            <span className="flex items-center gap-0.5">
                              <Car className="h-3 w-3" />{c.car_spaces}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
                        {c.sold_date && <span>Sold {fmtRelative(c.sold_date)}</span>}
                        {c.days_on_market != null && c.days_on_market > 0 && (
                          <span className="tabular-nums">{c.days_on_market}d on market</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
                return href ? (
                  <Link
                    key={c.property_key || i}
                    to={href}
                    className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xl"
                  >
                    {card}
                  </Link>
                ) : (
                  <div key={i}>{card}</div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Section 2: Nearby FlexMedia clients ─────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4 text-blue-600" />
            Nearby FlexMedia clients
            {neighbours.length > 0 && (
              <Badge variant="outline" className="text-[10px]">{neighbours.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {neighbours.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No FlexMedia clients active in {suburbLabel}.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {neighbours.slice(0, 5).map((n, i) => {
                const row = (
                  <div className="flex items-center gap-3 rounded-lg border border-border p-2.5 bg-card hover:bg-muted/40 transition-colors">
                    <Avatar className="h-10 w-10 shrink-0">
                      {n.profile_image && <AvatarImage src={n.profile_image} alt={n.full_name} />}
                      <AvatarFallback className="text-xs">{initials(n.full_name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{n.full_name || "—"}</p>
                      {n.agency_name && (
                        <p className="text-[11px] text-muted-foreground truncate">{n.agency_name}</p>
                      )}
                    </div>
                    {n.crm_agent_id && (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                  </div>
                );
                return n.crm_agent_id ? (
                  <Link
                    key={n.crm_agent_id || n.pulse_agent_id || i}
                    to={createPageUrl("PersonDetails") + `?id=${n.crm_agent_id}`}
                    className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
                  >
                    {row}
                  </Link>
                ) : (
                  <div key={n.pulse_agent_id || i}>{row}</div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Section 3: Suburb median snapshot ───────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5 text-indigo-600" />
            Suburb median (last 90d)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {medianLoading ? (
            <Skeleton className="h-10 w-48" />
          ) : medianStat ? (
            <div className="flex items-end gap-3">
              <p className="text-3xl font-bold tabular-nums text-indigo-700 leading-none">
                ${(medianStat.median / 1_000_000).toFixed(2)}M
              </p>
              <p className="text-xs text-muted-foreground tabular-nums pb-1">
                n={medianStat.n}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No sales recorded in {suburbLabel} in the last 90 days.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ComparablesCard({ comparables }) {
  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5 text-emerald-600" />
          Nearby comparables
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {comparables.slice(0, 5).map((c, i) => (
          <div key={c.property_key || c.id || i} className="flex items-start gap-2">
            <DollarSign className="h-3 w-3 text-emerald-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium truncate">{c.display_address || c.address || "—"}</p>
              <p className="text-[10px] text-muted-foreground">
                {c.sold_price ? `Sold $${(Number(c.sold_price) / 1_000_000).toFixed(2)}M` : "—"}
                {c.sold_date && ` · ${fmtDate(c.sold_date)}`}
              </p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────

function PropertyDetailsSkeleton() {
  return (
    <div className="pb-4 lg:pb-6">
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-border h-10 sm:h-12 px-3 lg:px-6 flex items-center gap-2">
        <Skeleton className="h-6 w-6 rounded-full" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="px-3 pt-2 space-y-3 lg:px-6">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr,320px] gap-4">
          <div className="space-y-3 min-w-0">
            <Card className="rounded-xl overflow-hidden">
              <div className="grid grid-cols-1 md:grid-cols-5">
                <Skeleton className="md:col-span-3 h-[40vh] md:h-[420px] rounded-none" />
                <div className="md:col-span-2 p-5 space-y-3">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-10 w-36" />
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-12 w-full" />
                </div>
              </div>
            </Card>
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="h-[70px] rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
          <aside className="hidden xl:block space-y-3">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </aside>
        </div>
      </div>
    </div>
  );
}

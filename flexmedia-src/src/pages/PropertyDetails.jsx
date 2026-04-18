/**
 * PropertyDetails — full property page
 *
 * URL: /PropertyDetails?key=<property_key>
 *
 * Unified timeline of every event ever attached to this physical property:
 *   - REA listing campaigns (for_sale, for_rent, sold, under_contract)
 *   - Sale completion events
 *   - FlexStudios projects/shoots
 *
 * Header: address + facts + agent/agency cross-references
 * Body: chronological timeline with grouped year buckets
 */
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Home, MapPin, Tag, DollarSign, Calendar, Users, Building2,
  ExternalLink, ArrowLeft, Loader2, Camera, History, TrendingUp, RefreshCw,
  Bed, Bath, Car, Plus, Eye, Images,
} from "lucide-react";
import AttachmentLightbox from "@/components/common/AttachmentLightbox";
import {
  formatAuctionDateTime,
  parseMediaItems,
} from "@/components/pulse/utils/listingHelpers";

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
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

const TYPE_BADGE = {
  for_sale: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300",
  for_rent: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300",
  sold: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300",
  under_contract: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300",
};
const TYPE_LABEL = {
  for_sale: "For Sale",
  for_rent: "For Rent",
  sold: "Sold",
  under_contract: "Under Contract",
  other: "Other",
};

const STATUS_BADGE = {
  booked: "bg-blue-50 text-blue-700 border-blue-200",
  scheduled: "bg-amber-50 text-amber-700 border-amber-200",
  uploaded: "bg-purple-50 text-purple-700 border-purple-200",
  delivered: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-red-50 text-red-700 border-red-200",
  pending_review: "bg-orange-50 text-orange-700 border-orange-200",
};

export default function PropertyDetails() {
  const location = useLocation();
  const propertyKey = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("key");
  }, [location.search]);

  const [property, setProperty] = useState(null);
  const [listings, setListings] = useState([]);
  const [projects, setProjects] = useState([]);
  // Tier 3 drill-through: resolve per-agent / per-agency pulse records +
  // CRM mappings so "Agents Detected" and "Agencies" link to the right place.
  const [pulseAgents, setPulseAgents] = useState([]);
  const [pulseAgencies, setPulseAgencies] = useState([]);
  const [pulseMappings, setPulseMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(null); // null = closed

  const load = useCallback(async () => {
    if (!propertyKey) return;
    setLoading(true);
    setError(null);
    try {
      const [pRes, lRes, prRes] = await Promise.all([
        api._supabase.from("property_full_v").select("*").eq("property_key", propertyKey).maybeSingle(),
        api._supabase.from("pulse_listings")
          .select("id, source_listing_id, address, suburb, postcode, listing_type, asking_price, sold_price, listed_date, sold_date, auction_date, price_text, agent_name, agent_rea_id, agency_name, agency_rea_id, source_url, image_url, hero_image, images, last_synced_at, first_seen_at, days_on_market, bedrooms, bathrooms, parking, land_size, property_type, detail_enriched_at, date_available, land_size_sqm, floorplan_urls, video_url, video_thumb_url, media_items, listing_withdrawn_at")
          .eq("property_key", propertyKey)
          .order("listed_date", { ascending: false, nullsFirst: false }),
        api._supabase.from("projects")
          .select("id, property_address, status, shoot_date, created_at, project_owner_name, agent_name, agency_id, tonomo_package, photographer_name")
          .eq("property_key", propertyKey)
          .order("shoot_date", { ascending: false, nullsFirst: false }),
      ]);
      if (pRes.error) throw pRes.error;
      if (lRes.error) throw lRes.error;
      if (prRes.error) throw prRes.error;
      setProperty(pRes.data);
      setListings(lRes.data || []);
      setProjects(prRes.data || []);

      // Second-pass lookups: for every agent/agency rea_id appearing in the
      // listings here, fetch the pulse record + CRM mapping in a single RT.
      const agentReaIds = Array.from(new Set((lRes.data || [])
        .map((l) => l.agent_rea_id).filter(Boolean)));
      const agencyReaIds = Array.from(new Set((lRes.data || [])
        .map((l) => l.agency_rea_id).filter(Boolean)));
      if (agentReaIds.length > 0 || agencyReaIds.length > 0) {
        const [paRes, pagRes, mapRes] = await Promise.all([
          agentReaIds.length > 0
            ? api._supabase.from("pulse_agents")
                .select("id, rea_agent_id, full_name, is_in_crm")
                .in("rea_agent_id", agentReaIds)
            : Promise.resolve({ data: [] }),
          agencyReaIds.length > 0
            ? api._supabase.from("pulse_agencies")
                .select("id, rea_agency_id, name, is_in_crm")
                .in("rea_agency_id", agencyReaIds)
            : Promise.resolve({ data: [] }),
          api._supabase.from("pulse_crm_mappings")
            .select("id, entity_type, pulse_entity_id, crm_entity_id, rea_id")
            .in("entity_type", ["agent", "agency"]),
        ]);
        if (paRes.error) throw paRes.error;
        if (pagRes.error) throw pagRes.error;
        if (mapRes.error) throw mapRes.error;
        setPulseAgents(paRes.data || []);
        setPulseAgencies(pagRes.data || []);
        setPulseMappings(mapRes.data || []);
      } else {
        setPulseAgents([]);
        setPulseAgencies([]);
        setPulseMappings([]);
      }
    } catch (err) {
      console.error("PropertyDetails load failed:", err);
      setError(err.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [propertyKey]);

  useEffect(() => { load(); }, [load]);

  // Build the unified timeline
  const timeline = useMemo(() => {
    const events = [];
    for (const l of listings) {
      const listedDate = l.listed_date || l.first_seen_at;
      if (listedDate) {
        events.push({ kind: "listing", date: listedDate, listing: l });
      }
      if (l.sold_date && l.sold_price) {
        events.push({ kind: "sale", date: l.sold_date, listing: l });
      }
    }
    for (const p of projects) {
      const date = p.shoot_date || p.created_at;
      if (date) {
        events.push({ kind: "project", date, project: p });
      }
    }
    return events.sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [listings, projects]);

  // Group timeline by year
  const groupedTimeline = useMemo(() => {
    const groups = new Map();
    for (const ev of timeline) {
      const year = new Date(ev.date).getFullYear();
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push(ev);
    }
    return Array.from(groups.entries()).sort((a, b) => b[0] - a[0]);
  }, [timeline]);

  // Aggregate all PHOTOS across all listings → lightbox gallery.
  // Uses parseMediaItems() so detail-enriched listings (migration 108+) only
  // contribute their photo-type items here; floorplans + video are rendered
  // separately below.
  const allImages = useMemo(() => {
    const out = [];
    for (const l of listings) {
      const media = parseMediaItems(l);
      const photos = media.photos.length > 0
        ? media.photos.map((p) => p.url)
        : (l.hero_image || l.image_url ? [l.hero_image || l.image_url] : []);
      photos.forEach((url, i) => {
        if (!url) return;
        out.push({
          file_name: `${l.agency_name || "Listing"} — ${fmtDate(l.listed_date || l.first_seen_at)} (${i + 1})`,
          file_url: url,
          file_type: "image/jpeg",
          _listing_id: l.id,
          _agent: l.agent_name,
          _agency: l.agency_name,
        });
      });
    }
    return out;
  }, [listings]);

  // Floorplans + video aggregated across listings (detail-enriched only).
  const allFloorplans = useMemo(() => {
    const out = [];
    for (const l of listings) {
      const media = parseMediaItems(l);
      for (const fp of media.floorplans) {
        out.push({ ...fp, listingId: l.id, agencyName: l.agency_name });
      }
    }
    return out;
  }, [listings]);

  const latestVideo = useMemo(() => {
    for (const l of listings) {
      const media = parseMediaItems(l);
      if (media.video) return { ...media.video, listing: l };
    }
    return null;
  }, [listings]);

  // Unique agents/agencies — decorated with resolved link targets (CRM if
  // mapped, else Industry Pulse slideout, else plain text).
  const uniqueAgents = useMemo(() => {
    const map = new Map();
    for (const l of listings) {
      if (!l.agent_rea_id || !l.agent_name) continue;
      if (!map.has(l.agent_rea_id)) map.set(l.agent_rea_id, { reaId: l.agent_rea_id, name: l.agent_name, count: 0, latest: null });
      const e = map.get(l.agent_rea_id);
      e.count++;
      if (!e.latest || new Date(l.listed_date || 0) > new Date(e.latest)) e.latest = l.listed_date;
    }
    const agents = Array.from(map.values());
    // Resolve link target for each: CRM (mapping) > Pulse slideout (pulse agent) > text.
    for (const a of agents) {
      const pa = pulseAgents.find((p) => p.rea_agent_id === a.reaId);
      a.pulseId = pa?.id || null;
      if (pa) {
        const m = pulseMappings.find((mm) =>
          mm.entity_type === "agent" &&
          (mm.pulse_entity_id === pa.id || String(mm.rea_id) === String(a.reaId))
        );
        a.crmEntityId = m?.crm_entity_id || null;
      } else {
        a.crmEntityId = null;
      }
    }
    return agents.sort((a, b) => b.count - a.count);
  }, [listings, pulseAgents, pulseMappings]);

  const uniqueAgencies = useMemo(() => {
    const map = new Map();
    for (const l of listings) {
      if (!l.agency_name && !l.agency_rea_id) continue;
      const key = l.agency_rea_id || l.agency_name;
      if (!map.has(key)) map.set(key, { reaId: l.agency_rea_id, name: l.agency_name, count: 0 });
      map.get(key).count++;
    }
    const agencies = Array.from(map.values());
    for (const ag of agencies) {
      if (!ag.reaId) { ag.pulseId = null; ag.crmEntityId = null; continue; }
      const pa = pulseAgencies.find((p) => p.rea_agency_id === ag.reaId);
      ag.pulseId = pa?.id || null;
      if (pa) {
        const m = pulseMappings.find((mm) =>
          mm.entity_type === "agency" &&
          (mm.pulse_entity_id === pa.id || String(mm.rea_id) === String(ag.reaId))
        );
        ag.crmEntityId = m?.crm_entity_id || null;
      } else {
        ag.crmEntityId = null;
      }
    }
    return agencies.sort((a, b) => b.count - a.count);
  }, [listings, pulseAgencies, pulseMappings]);

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

  if (loading) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6">
        <Card><CardContent className="py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading property…
        </CardContent></Card>
      </div>
    );
  }

  if (error || !property) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6">
        <Card><CardContent className="py-12 text-center">
          <Home className="h-10 w-10 mx-auto mb-2 opacity-30 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {error || "Property not found."}
          </p>
          <Link to="/Properties"><Button variant="outline" size="sm" className="mt-2">Back to Properties</Button></Link>
        </CardContent></Card>
      </div>
    );
  }

  // Smart current-state label
  const currentState = (() => {
    const now = Date.now();
    const dayMs = 86400000;
    const listedDate = property.current_listed_date ? new Date(property.current_listed_date).getTime() : null;
    const soldDate = property.last_sold_at ? new Date(property.last_sold_at).getTime() : null;

    if (property.current_listing_type && listedDate && (now - listedDate) < 90 * dayMs) {
      return { label: TYPE_LABEL[property.current_listing_type] || property.current_listing_type, fresh: true, cls: TYPE_BADGE[property.current_listing_type] };
    }
    if (soldDate && (now - soldDate) < 180 * dayMs) {
      return { label: "Recently Sold", fresh: true, cls: TYPE_BADGE.sold };
    }
    if (property.current_listing_type) {
      return { label: `Was ${TYPE_LABEL[property.current_listing_type]}`, fresh: false, cls: "bg-muted/60 text-muted-foreground border-transparent" };
    }
    return null;
  })();

  const facts = [];
  if (property.bedrooms) facts.push({ icon: Bed, val: property.bedrooms });
  if (property.bathrooms) facts.push({ icon: Bath, val: property.bathrooms });
  if (property.parking) facts.push({ icon: Car, val: property.parking });

  // CRM agent at this property (if linked via project)
  const linkedAgentName = projects.find((p) => p.agent_name)?.agent_name;

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Link to="/Properties">
            <Button variant="ghost" size="sm" className="h-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <Home className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-bold tracking-tight">{property.display_address}</h1>
            <p className="text-[11px] text-muted-foreground">
              {property.suburb}{property.postcode ? ` · ${property.postcode}` : ""} · {property.state || "NSW"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/ProjectDetails?id=new&address=${encodeURIComponent(property.display_address)}`}>
            <Button variant="default" size="sm" className="h-8 text-xs">
              <Plus className="h-3.5 w-3.5 mr-1" /> Create project here
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Hero image + facts strip (only if hero image exists) */}
      {property.hero_image && (
        <Card className="rounded-xl overflow-hidden">
          <div className="grid grid-cols-1 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => allImages.length > 0 && setLightboxIndex(0)}
              className="sm:col-span-1 bg-muted h-48 sm:h-auto overflow-hidden group relative cursor-pointer block"
              disabled={allImages.length === 0}
            >
              <img
                src={property.hero_image}
                alt=""
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }}
              />
              {allImages.length > 0 && (
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity text-white text-xs font-medium flex items-center gap-1.5 bg-black/60 rounded-full px-3 py-1.5">
                    <Images className="h-3.5 w-3.5" />
                    View {allImages.length} photo{allImages.length !== 1 ? 's' : ''}
                  </span>
                </div>
              )}
            </button>
            <div className="sm:col-span-2 p-4 flex flex-col justify-center gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                {currentState && (
                  <Badge variant="outline" className={cn("text-[10px]", currentState.cls)}>
                    {currentState.label}
                  </Badge>
                )}
                {property.property_type && (
                  <Badge variant="outline" className="text-[10px] capitalize">{property.property_type}</Badge>
                )}
                {allImages.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    <Images className="h-2.5 w-2.5 mr-1" /> {allImages.length} photos
                  </Badge>
                )}
              </div>
              {(property.current_asking_price || property.last_sold_price) && (
                <p className="text-2xl font-bold tabular-nums">
                  {fmtPrice(property.current_asking_price || property.last_sold_price)}
                  {!currentState?.fresh && <span className="text-xs font-normal text-muted-foreground ml-2">historical</span>}
                </p>
              )}
              {facts.length > 0 && (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  {facts.map((f, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <f.icon className="h-3.5 w-3.5" /> {f.val}
                    </span>
                  ))}
                </div>
              )}
              {linkedAgentName && (
                <p className="text-xs text-muted-foreground">
                  Last shot for: <span className="font-medium text-foreground">{linkedAgentName}</span>
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Lightbox — uses existing AttachmentLightbox component */}
      {lightboxIndex !== null && allImages.length > 0 && (
        <AttachmentLightbox
          files={allImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {/* Floorplans + Video (detail-enriched, migration 108+) */}
      {(allFloorplans.length > 0 || latestVideo) && (
        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Images className="h-4 w-4 text-indigo-600" />
              Detail Media
              {allFloorplans.length > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {allFloorplans.length} floorplan{allFloorplans.length !== 1 ? "s" : ""}
                </Badge>
              )}
              {latestVideo && <Badge variant="outline" className="text-[10px]">Video</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {allFloorplans.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
                  Floorplans
                </p>
                <div className="flex flex-wrap gap-2">
                  {allFloorplans.map((fp, i) => (
                    <a
                      key={i}
                      href={fp.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                      title={fp.agencyName || "Floorplan"}
                    >
                      <img
                        src={fp.thumb || fp.url}
                        alt={`Floorplan ${i + 1}`}
                        className="h-24 w-32 object-contain rounded border border-border bg-white hover:shadow-md transition-shadow"
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
            {latestVideo && (() => {
              const yt = latestVideo.url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([A-Za-z0-9_-]{11})/);
              return (
                <div>
                  <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
                    Video
                  </p>
                  {yt ? (
                    <iframe
                      src={`https://www.youtube.com/embed/${yt[1]}`}
                      title="Listing video"
                      className="w-full max-w-lg aspect-video rounded border border-border"
                      frameBorder="0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  ) : (
                    <a
                      href={latestVideo.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                    >
                      Watch video
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Auction info (detail-enriched, migration 108+) — only when the
          current listing state is for_sale and price_text mentions auction. */}
      {(() => {
        const currentListing = listings[0];
        if (!currentListing?.auction_date) return null;
        const priceText = (currentListing.price_text || "").toLowerCase();
        if (!priceText.includes("auction")) return null;
        return (
          <Card className="rounded-xl border-amber-200/60 bg-amber-50/30 dark:bg-amber-950/10">
            <CardContent className="p-3 flex items-center gap-2">
              <Tag className="h-4 w-4 text-amber-600 shrink-0" />
              <div className="text-xs">
                <p className="font-semibold text-amber-800 dark:text-amber-300">Auction</p>
                <p className="text-foreground">{formatAuctionDateTime(currentListing.auction_date)}</p>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Listings" value={property.listing_count || 0} icon={Building2} color="text-blue-600" subtitle="REA campaigns" />
        <StatCard label="Projects" value={property.project_count || 0} icon={Camera} color="text-violet-600" subtitle="Our shoots" />
        <StatCard label="Sales" value={property.sold_listing_count || 0} icon={DollarSign} color="text-emerald-600" subtitle="Completed sales" />
        <StatCard label="Last Sold" value={fmtPrice(property.last_sold_price)} icon={TrendingUp} subtitle={fmtDate(property.last_sold_at)} />
        <StatCard label="Now" value={property.current_listing_type ? TYPE_LABEL[property.current_listing_type] || "Active" : "—"} icon={Tag} subtitle={fmtPrice(property.current_asking_price)} />
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Left: Timeline (2/3) */}
        <Card className="lg:col-span-2 rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <History className="h-4 w-4" /> Property Timeline
              <Badge variant="outline" className="text-[10px] ml-auto">
                {timeline.length} events
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {groupedTimeline.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">No events yet</p>
            ) : (
              groupedTimeline.map(([year, events]) => (
                <div key={year}>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">{year}</p>
                    <div className="flex-1 border-t border-border/60"></div>
                    <span className="text-[10px] text-muted-foreground/70">{events.length} event{events.length !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="space-y-2 ml-2 border-l-2 border-border/40 pl-4">
                    {events.map((ev, i) => (
                      <TimelineCard key={i} event={ev} />
                    ))}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Right: Cross-references (1/3) */}
        <div className="space-y-3">
          {/* Linked Projects */}
          <Card className="rounded-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Camera className="h-4 w-4 text-violet-600" />
                FlexStudios Projects ({projects.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {projects.length === 0 ? (
                <p className="text-xs text-muted-foreground">No shoots at this property yet.</p>
              ) : projects.map((p) => (
                <Link key={p.id} to={`/ProjectDetails?id=${p.id}`} className="block hover:bg-muted/40 rounded p-1.5 -mx-1.5 transition-colors">
                  <div className="flex items-start gap-2">
                    <Tag className="h-3 w-3 text-violet-600 mt-1 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{p.tonomo_package || "Project"}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {p.agent_name && <>{p.agent_name} · </>}
                        {fmtDate(p.shoot_date || p.created_at)}
                      </p>
                    </div>
                    <Badge variant="outline" className={cn("text-[9px] shrink-0", STATUS_BADGE[p.status] || "")}>
                      {p.status}
                    </Badge>
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>

          {/* Agents detected — Tier 3: each row resolves to CRM, Pulse, or
              static text based on what mapping data is available. */}
          <Card className="rounded-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Users className="h-4 w-4 text-blue-600" />
                Agents Detected ({uniqueAgents.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {uniqueAgents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No agents detected yet.</p>
              ) : uniqueAgents.map((a) => {
                const label = (
                  <>
                    <span className="truncate">{a.name}</span>
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {a.count} campaign{a.count !== 1 ? "s" : ""}
                    </Badge>
                  </>
                );
                if (a.crmEntityId) {
                  return (
                    <Link
                      key={a.reaId}
                      to={`/people/${a.crmEntityId}`}
                      className="flex items-center justify-between text-xs text-primary hover:underline"
                      title="Open CRM record"
                    >
                      {label}
                    </Link>
                  );
                }
                if (a.pulseId) {
                  return (
                    <Link
                      key={a.reaId}
                      to={`/IndustryPulse?tab=agents&pulse_id=${a.pulseId}`}
                      className="flex items-center justify-between text-xs hover:underline"
                      title="Open Industry Pulse record"
                    >
                      {label}
                    </Link>
                  );
                }
                return (
                  <div
                    key={a.reaId}
                    className="flex items-center justify-between text-xs"
                    title="No Industry Pulse record yet"
                  >
                    {label}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Agencies detected */}
          <Card className="rounded-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Building2 className="h-4 w-4 text-amber-600" />
                Agencies ({uniqueAgencies.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {uniqueAgencies.length === 0 ? (
                <p className="text-xs text-muted-foreground">No agencies detected yet.</p>
              ) : uniqueAgencies.map((a, i) => {
                const label = (
                  <>
                    <span className="truncate">{a.name}</span>
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {a.count}
                    </Badge>
                  </>
                );
                if (a.crmEntityId) {
                  return (
                    <Link
                      key={a.reaId || a.name || i}
                      to={`/organisations/${a.crmEntityId}`}
                      className="flex items-center justify-between text-xs text-primary hover:underline"
                      title="Open CRM record"
                    >
                      {label}
                    </Link>
                  );
                }
                if (a.pulseId) {
                  return (
                    <Link
                      key={a.reaId || a.name || i}
                      to={`/IndustryPulse?tab=agencies&pulse_id=${a.pulseId}`}
                      className="flex items-center justify-between text-xs hover:underline"
                      title="Open Industry Pulse record"
                    >
                      {label}
                    </Link>
                  );
                }
                return (
                  <div
                    key={a.reaId || a.name || i}
                    className="flex items-center justify-between text-xs"
                    title="No Industry Pulse record yet"
                  >
                    {label}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Identity */}
          <Card className="rounded-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Identity
              </CardTitle>
            </CardHeader>
            <CardContent className="text-[10px] text-muted-foreground space-y-0.5 font-mono">
              <p><span className="opacity-60">key:</span> {property.property_key}</p>
              <p><span className="opacity-60">first seen:</span> {fmtDate(property.first_seen_at)}</p>
              <p><span className="opacity-60">last seen:</span> {fmtDate(property.last_seen_at)}</p>
              {property.latitude && (
                <p><span className="opacity-60">geo:</span> {Number(property.latitude).toFixed(5)}, {Number(property.longitude).toFixed(5)}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color, subtitle }) {
  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardContent className="p-3 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted/60">
          <Icon className={cn("h-4 w-4", color || "text-muted-foreground")} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-base font-bold tabular-nums leading-none", color || "text-foreground")}>
            {typeof value === "number" ? value.toLocaleString() : value}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
          {subtitle && <p className="text-[9px] text-muted-foreground/60 truncate">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function TimelineCard({ event }) {
  if (event.kind === "project") {
    const p = event.project;
    return (
      <Link to={`/ProjectDetails?id=${p.id}`} className="block bg-violet-50/40 dark:bg-violet-950/20 border border-violet-200/60 rounded p-2 hover:bg-violet-50 dark:hover:bg-violet-950/40 transition-colors">
        <div className="flex items-start gap-2">
          <Camera className="h-3.5 w-3.5 text-violet-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium">
              FlexStudios shoot — {p.tonomo_package || "Project"}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {p.agent_name && <>Agent: {p.agent_name} · </>}
              {p.photographer_name && <>📷 {p.photographer_name} · </>}
              {fmtDate(event.date)}
            </p>
          </div>
          <Badge variant="outline" className={cn("text-[9px] shrink-0", STATUS_BADGE[p.status] || "")}>
            {p.status}
          </Badge>
        </div>
      </Link>
    );
  }

  if (event.kind === "sale") {
    const l = event.listing;
    return (
      <div className="bg-emerald-50/40 dark:bg-emerald-950/20 border border-emerald-200/60 rounded p-2">
        <div className="flex items-start gap-2">
          <DollarSign className="h-3.5 w-3.5 text-emerald-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold">
              SOLD <span className="tabular-nums">{fmtPrice(l.sold_price)}</span>
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {l.agent_name && <>{l.agent_name} · </>}
              {l.agency_name} · {fmtDate(event.date)}
            </p>
          </div>
          {l.source_url && (
            <a href={l.source_url} target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-700">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    );
  }

  // listing
  const l = event.listing;
  return (
    <div className="bg-muted/40 border border-border/60 rounded p-2">
      <div className="flex items-start gap-2">
        <Building2 className="h-3.5 w-3.5 text-blue-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium flex items-center gap-1.5">
            <Badge variant="outline" className={cn("text-[9px]", TYPE_BADGE[l.listing_type] || "")}>
              {TYPE_LABEL[l.listing_type] || l.listing_type}
            </Badge>
            <span className="tabular-nums">{fmtPrice(l.asking_price)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {l.agent_name && <>{l.agent_name} · </>}
            {l.agency_name} · {fmtDate(event.date)}
            {l.bedrooms && <> · {l.bedrooms}br</>}
            {l.bathrooms && <>/{l.bathrooms}ba</>}
            {l.parking && <>/{l.parking}car</>}
          </p>
        </div>
        {l.source_url && (
          <a href={l.source_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-700">
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * PropertyIntelligencePanel
 *
 * Embeddable card showing the unified pulse intelligence for a single
 * physical property (1 property = N listings + N projects over time).
 *
 * Used in:
 *   - ProjectDetails (right rail) — discovers other listings/campaigns at the same address
 *   - PropertyDetails page         — full page view
 *   - Future: ListingSlideout       — link to property page
 *
 * Data source: property_full_v view (joins on property_key)
 *
 * Props:
 *   propertyKey: string — the normalized key (e.g. project.property_key)
 *   compact?: bool     — render condensed (no header/footer chrome)
 *   onOpenListing?: (listing) => void — callback when a listing row is clicked
 *   onOpenAgent?: (agent_rea_id) => void
 *   onOpenAgency?: (agency_rea_id) => void
 */

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Home, MapPin, DollarSign, Calendar, Users, Building2, ExternalLink,
  TrendingUp, History, Clock, Tag, ArrowRight, Loader2,
} from "lucide-react";

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
  } catch {
    return "—";
  }
}
function fmtRelative(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    const diffMs = Date.now() - dt.getTime();
    const days = Math.floor(diffMs / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  } catch {
    return "—";
  }
}

const TYPE_BADGE = {
  for_sale:       "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300",
  for_rent:       "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300",
  sold:           "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300",
  under_contract: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300",
};
const TYPE_LABEL = {
  for_sale: "For Sale",
  for_rent: "For Rent",
  sold: "Sold",
  under_contract: "Under Contract",
  other: "Other",
};

export default function PropertyIntelligencePanel({
  propertyKey,
  compact = false,
  onOpenListing,
  onOpenAgent,
  onOpenAgency,
}) {
  const [property, setProperty] = useState(null);
  const [listings, setListings] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!propertyKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // 1. Property identity + aggregates from view
      const propRes = await api._supabase
        .from("property_full_v")
        .select("*")
        .eq("property_key", propertyKey)
        .maybeSingle();
      if (propRes.error) throw propRes.error;
      setProperty(propRes.data);

      // 2. All listings at this property (for timeline detail)
      const listRes = await api._supabase
        .from("pulse_listings")
        .select("id, source_listing_id, address, listing_type, asking_price, sold_price, listed_date, sold_date, agent_name, agent_rea_id, agency_name, agency_rea_id, source_url, image_url, hero_image, last_synced_at, first_seen_at")
        .eq("property_key", propertyKey)
        .order("listed_date", { ascending: false, nullsFirst: false });
      if (listRes.error) throw listRes.error;
      setListings(listRes.data || []);

      // 3. All projects at this property
      const projRes = await api._supabase
        .from("projects")
        .select("id, property_address, status, shoot_date, created_at, project_owner_name, agent_name, agency_id")
        .eq("property_key", propertyKey)
        .order("shoot_date", { ascending: false, nullsFirst: false });
      if (projRes.error) throw projRes.error;
      setProjects(projRes.data || []);
    } catch (err) {
      console.error("PropertyIntelligencePanel load failed:", err);
      setError(err.message || "Failed to load property data");
    } finally {
      setLoading(false);
    }
  }, [propertyKey]);

  useEffect(() => { load(); }, [load]);

  // Build a unified, time-sorted timeline from listings + projects
  const timeline = useMemo(() => {
    const events = [];
    for (const l of listings) {
      const date = l.listed_date || l.first_seen_at;
      if (date) {
        events.push({
          kind: "listing",
          date,
          listing: l,
        });
      }
      if (l.sold_date && l.sold_price) {
        events.push({
          kind: "sale",
          date: l.sold_date,
          listing: l,
        });
      }
    }
    for (const p of projects) {
      const date = p.shoot_date || p.created_at;
      if (date) {
        events.push({
          kind: "project",
          date,
          project: p,
        });
      }
    }
    return events.sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [listings, projects]);

  // Unique agents/agencies seen at this property over time
  const uniqueAgents = useMemo(() => {
    const map = new Map();
    for (const l of listings) {
      if (!l.agent_rea_id || !l.agent_name) continue;
      if (!map.has(l.agent_rea_id)) map.set(l.agent_rea_id, { id: l.agent_rea_id, name: l.agent_name, count: 0 });
      map.get(l.agent_rea_id).count++;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [listings]);

  const uniqueAgencies = useMemo(() => {
    const map = new Map();
    for (const l of listings) {
      if (!l.agency_rea_id && !l.agency_name) continue;
      const key = l.agency_rea_id || l.agency_name;
      if (!map.has(key)) map.set(key, { id: l.agency_rea_id, name: l.agency_name, count: 0 });
      map.get(key).count++;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [listings]);

  if (loading) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-8 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading property intelligence…
        </CardContent>
      </Card>
    );
  }

  if (!propertyKey) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-6 text-center">
          <Home className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">No address — cannot link to property intelligence.</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-4 text-xs text-red-600">
          Failed to load: {error}
        </CardContent>
      </Card>
    );
  }

  if (!property) {
    return (
      <Card className="rounded-xl">
        {!compact && (
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Home className="h-4 w-4 text-primary" />
              Property Intelligence
            </CardTitle>
          </CardHeader>
        )}
        <CardContent className="py-4 text-center">
          <Home className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground mb-2">
            No REA listings detected yet
          </p>
          <p className="text-[10px] text-muted-foreground/70 leading-tight">
            REA per-suburb scrapes catch the 10-15 newest listings.
            This property will appear here when it's listed AND in that batch.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl">
      {!compact && (
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Home className="h-4 w-4 text-primary" />
            Property Intelligence
            <Link to={`/PropertyDetails?key=${encodeURIComponent(propertyKey)}`} className="ml-auto">
              <Button variant="ghost" size="sm" className="h-6 text-[10px]">
                Full view <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className="space-y-3">
        {/* Hero strip — image + address */}
        <div className="flex items-start gap-2">
          {property.hero_image && (
            <div className="w-20 h-20 rounded-md bg-muted overflow-hidden flex-shrink-0 border border-border/40">
              <img
                src={property.hero_image}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }}
              />
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-xs font-medium flex items-center gap-1.5">
              <MapPin className="h-3 w-3 text-muted-foreground" />
              <span className="truncate">{property.display_address}</span>
            </p>
            {(property.suburb || property.postcode) && (
              <p className="text-[10px] text-muted-foreground ml-4">
                {property.suburb}{property.postcode ? ` · ${property.postcode}` : ""}
              </p>
            )}
            {(property.bedrooms || property.bathrooms || property.parking) && (
              <p className="text-[10px] text-muted-foreground ml-4">
                {property.bedrooms ? `${property.bedrooms}br` : ""}
                {property.bathrooms ? `/${property.bathrooms}ba` : ""}
                {property.parking ? `/${property.parking}car` : ""}
                {property.property_type && ` · ${property.property_type}`}
              </p>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Listings</p>
            <p className="text-base font-bold tabular-nums leading-none">{property.listing_count || 0}</p>
            <p className="text-[9px] text-muted-foreground/70">REA campaigns</p>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Projects</p>
            <p className="text-base font-bold tabular-nums leading-none">{property.project_count || 0}</p>
            <p className="text-[9px] text-muted-foreground/70">FlexStudios shoots</p>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Last Sold</p>
            <p className="text-base font-bold tabular-nums leading-none">{fmtPrice(property.last_sold_price)}</p>
            <p className="text-[9px] text-muted-foreground/70">{fmtDate(property.last_sold_at)}</p>
          </div>
        </div>

        {/* Current state */}
        {property.current_listing_type && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Currently:</span>
            <Badge variant="outline" className={cn("text-[10px]", TYPE_BADGE[property.current_listing_type] || "")}>
              {TYPE_LABEL[property.current_listing_type] || property.current_listing_type}
            </Badge>
            {property.current_asking_price && (
              <span className="font-semibold tabular-nums">{fmtPrice(property.current_asking_price)}</span>
            )}
          </div>
        )}

        {/* Agents detected */}
        {uniqueAgents.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
              <Users className="h-3 w-3" /> Agents detected ({uniqueAgents.length})
            </p>
            <div className="flex flex-wrap gap-1">
              {uniqueAgents.slice(0, 6).map((a) => (
                <button
                  key={a.id}
                  onClick={() => onOpenAgent && onOpenAgent(a.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-muted/60 hover:bg-muted px-1.5 py-0.5 text-[10px] transition-colors"
                  title={`${a.count} campaign${a.count !== 1 ? "s" : ""}`}
                >
                  {a.name}
                  {a.count > 1 && <span className="text-muted-foreground">×{a.count}</span>}
                </button>
              ))}
              {uniqueAgents.length > 6 && (
                <span className="text-[10px] text-muted-foreground self-center">+{uniqueAgents.length - 6} more</span>
              )}
            </div>
          </div>
        )}

        {/* Agencies detected */}
        {uniqueAgencies.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
              <Building2 className="h-3 w-3" /> Agencies detected ({uniqueAgencies.length})
            </p>
            <div className="flex flex-wrap gap-1">
              {uniqueAgencies.slice(0, 4).map((a, i) => (
                <button
                  key={a.id || a.name || i}
                  onClick={() => a.id && onOpenAgency && onOpenAgency(a.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-muted/60 hover:bg-muted px-1.5 py-0.5 text-[10px] transition-colors"
                >
                  {a.name}
                  {a.count > 1 && <span className="text-muted-foreground">×{a.count}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        {timeline.length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
              <History className="h-3 w-3" /> Timeline ({timeline.length})
            </p>
            <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
              {timeline.slice(0, compact ? 6 : 20).map((ev, i) => (
                <TimelineRow
                  key={i}
                  event={ev}
                  onOpenListing={onOpenListing}
                />
              ))}
              {timeline.length > (compact ? 6 : 20) && (
                <p className="text-[10px] text-muted-foreground text-center py-1">
                  + {timeline.length - (compact ? 6 : 20)} more events —{" "}
                  <Link to={`/PropertyDetails?key=${encodeURIComponent(propertyKey)}`} className="underline">
                    full view
                  </Link>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="pt-1 border-t flex items-center justify-between">
          <span className="text-[9px] text-muted-foreground">
            First seen: {fmtRelative(property.first_seen_at)}
          </span>
          <Link to={`/PropertyDetails?key=${encodeURIComponent(propertyKey)}`}>
            <Button variant="link" size="sm" className="h-auto p-0 text-[10px]">
              Open property page →
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function TimelineRow({ event, onOpenListing }) {
  if (event.kind === "project") {
    const p = event.project;
    return (
      <Link to={`/ProjectDetails?id=${p.id}`} className="flex items-start gap-2 text-[11px] hover:bg-muted/40 rounded px-1 py-0.5 transition-colors">
        <Tag className="h-3 w-3 text-violet-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">
            FlexStudios shoot · <span className="text-muted-foreground capitalize">{p.status}</span>
          </p>
          <p className="text-[10px] text-muted-foreground">
            {p.agent_name && <>{p.agent_name} · </>}
            {fmtDate(event.date)}
          </p>
        </div>
      </Link>
    );
  }

  if (event.kind === "sale") {
    const l = event.listing;
    return (
      <button
        onClick={() => onOpenListing && onOpenListing(l)}
        className="w-full flex items-start gap-2 text-[11px] hover:bg-muted/40 rounded px-1 py-0.5 transition-colors text-left"
      >
        <DollarSign className="h-3 w-3 text-emerald-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">
            SOLD <span className="tabular-nums">{fmtPrice(l.sold_price)}</span>
          </p>
          <p className="text-[10px] text-muted-foreground truncate">
            {l.agent_name && <>{l.agent_name} · </>}
            {l.agency_name} · {fmtDate(event.date)}
          </p>
        </div>
      </button>
    );
  }

  // listing
  const l = event.listing;
  const typeColor = TYPE_BADGE[l.listing_type] || "bg-muted text-muted-foreground border-transparent";
  return (
    <button
      onClick={() => onOpenListing && onOpenListing(l)}
      className="w-full flex items-start gap-2 text-[11px] hover:bg-muted/40 rounded px-1 py-0.5 transition-colors text-left"
    >
      <Home className="h-3 w-3 text-blue-600 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium flex items-center gap-1">
          <Badge variant="outline" className={cn("text-[8px] py-0 px-1", typeColor)}>
            {TYPE_LABEL[l.listing_type] || l.listing_type}
          </Badge>
          <span className="tabular-nums">{fmtPrice(l.asking_price)}</span>
        </p>
        <p className="text-[10px] text-muted-foreground truncate">
          {l.agent_name && <>{l.agent_name} · </>}
          {l.agency_name} · {fmtDate(event.date)}
        </p>
      </div>
    </button>
  );
}

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
  Bed, Bath, Car, Plus, Eye,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!propertyKey) return;
    setLoading(true);
    setError(null);
    try {
      const [pRes, lRes, prRes] = await Promise.all([
        api._supabase.from("property_full_v").select("*").eq("property_key", propertyKey).maybeSingle(),
        api._supabase.from("pulse_listings")
          .select("id, source_listing_id, address, suburb, postcode, listing_type, asking_price, sold_price, listed_date, sold_date, agent_name, agent_rea_id, agency_name, agency_rea_id, source_url, image_url, hero_image, last_synced_at, first_seen_at, days_on_market, bedrooms, bathrooms, parking, land_size, property_type")
          .eq("property_key", propertyKey)
          .order("listed_date", { ascending: false, nullsFirst: false }),
        api._supabase.from("projects")
          .select("id, property_address, status, shoot_date, created_at, primary_owner_name, agent_name, agency_id, package_name, photographer_name")
          .eq("property_key", propertyKey)
          .order("shoot_date", { ascending: false, nullsFirst: false }),
      ]);
      if (pRes.error) throw pRes.error;
      if (lRes.error) throw lRes.error;
      if (prRes.error) throw prRes.error;
      setProperty(pRes.data);
      setListings(lRes.data || []);
      setProjects(prRes.data || []);
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

  // Unique agents/agencies
  const uniqueAgents = useMemo(() => {
    const map = new Map();
    for (const l of listings) {
      if (!l.agent_rea_id || !l.agent_name) continue;
      if (!map.has(l.agent_rea_id)) map.set(l.agent_rea_id, { id: l.agent_rea_id, name: l.agent_name, count: 0, latest: null });
      const e = map.get(l.agent_rea_id);
      e.count++;
      if (!e.latest || new Date(l.listed_date || 0) > new Date(e.latest)) e.latest = l.listed_date;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [listings]);

  const uniqueAgencies = useMemo(() => {
    const map = new Map();
    for (const l of listings) {
      if (!l.agency_name && !l.agency_rea_id) continue;
      const key = l.agency_rea_id || l.agency_name;
      if (!map.has(key)) map.set(key, { id: l.agency_rea_id, name: l.agency_name, count: 0 });
      map.get(key).count++;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [listings]);

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
            <div className="sm:col-span-1 bg-muted h-48 sm:h-auto overflow-hidden">
              <img
                src={property.hero_image}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }}
              />
            </div>
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
                      <p className="text-xs font-medium truncate">{p.package_name || "Project"}</p>
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

          {/* Agents detected */}
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
              ) : uniqueAgents.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-xs">
                  <span className="truncate">{a.name}</span>
                  <Badge variant="outline" className="text-[9px] shrink-0">
                    {a.count} campaign{a.count !== 1 ? "s" : ""}
                  </Badge>
                </div>
              ))}
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
              ) : uniqueAgencies.map((a, i) => (
                <div key={a.id || a.name || i} className="flex items-center justify-between text-xs">
                  <span className="truncate">{a.name}</span>
                  <Badge variant="outline" className="text-[9px] shrink-0">
                    {a.count}
                  </Badge>
                </div>
              ))}
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
              FlexStudios shoot — {p.package_name || "Project"}
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

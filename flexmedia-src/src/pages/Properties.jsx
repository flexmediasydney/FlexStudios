/**
 * Properties — index page with 3 views: List | Suburbs | Map
 *
 * Backed by:
 *   - property_full_v (per-property identity + aggregates + hero image + facts)
 *   - property_suburb_stats_v (suburb-level aggregates)
 *
 * One row per physical address regardless of how many campaigns/projects.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  Home, Search, MapPin, Camera, Tag, DollarSign, Loader2, ArrowRight,
  Filter, Building2, Users, RefreshCw, Bed, Bath, Car, Map as MapIcon,
  Layers, List as ListIcon, TrendingUp,
} from "lucide-react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import { LEAFLET_ICON_OPTIONS } from "@/lib/constants";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Leaflet icon fix (same as SalesMap)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions(LEAFLET_ICON_OPTIONS);

const PAGE_SIZE = 50;
const SYDNEY_CENTER = [-33.8688, 151.2093];
const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTR = "&copy; OpenStreetMap &copy; CARTO";

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
function fmtRelative(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    const days = Math.floor((Date.now() - dt.getTime()) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
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

const FILTER_TABS = [
  { value: "all",          label: "All" },
  { value: "with_project", label: "Mine" },
  { value: "linked",       label: "Linked" },
  { value: "multi_listing", label: "Multi-campaign" },
  { value: "for_sale",      label: "For Sale" },
  { value: "sold",          label: "Recently Sold" },
];

export default function Properties() {
  const [view, setView] = useState("list"); // list | suburbs | map
  const [properties, setProperties] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const [page, setPage] = useState(0);
  const [stats, setStats] = useState(null);
  const [suburbs, setSuburbs] = useState([]);
  const [suburbSort, setSuburbSort] = useState("total_properties");

  // List view fetch
  const fetchProperties = useCallback(async () => {
    if (view !== "list") return;
    setLoading(true);
    try {
      let q = api._supabase.from("property_full_v").select("*", { count: "exact" });

      if (search.trim()) {
        const s = `%${search.trim().toLowerCase()}%`;
        q = q.or(`display_address.ilike.${s},suburb.ilike.${s},postcode.ilike.${s}`);
      }
      if (tab === "with_project") q = q.gt("project_count", 0);
      if (tab === "linked") q = q.gt("project_count", 0).gt("listing_count", 0);
      if (tab === "multi_listing") q = q.gt("listing_count", 1);
      if (tab === "for_sale") q = q.eq("current_listing_type", "for_sale");
      if (tab === "sold") q = q.eq("current_listing_type", "sold");

      q = q.order("last_seen_at", { ascending: false, nullsFirst: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      const { data, error, count } = await q;
      if (error) throw error;
      setProperties(data || []);
      setTotal(count || 0);
    } catch (err) {
      console.error("Properties fetch failed:", err);
      setProperties([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, tab, page, view]);
  useEffect(() => { fetchProperties(); }, [fetchProperties]);

  // Map view fetch — all properties with coords
  const [mapProperties, setMapProperties] = useState([]);
  const [mapLoading, setMapLoading] = useState(false);
  const fetchMapProperties = useCallback(async () => {
    if (view !== "map") return;
    setMapLoading(true);
    try {
      let q = api._supabase
        .from("property_full_v")
        .select("id, property_key, display_address, suburb, latitude, longitude, project_count, listing_count, current_listing_type, current_asking_price, last_sold_price, hero_image")
        .not("latitude", "is", null)
        .not("longitude", "is", null);
      if (search.trim()) {
        const s = `%${search.trim().toLowerCase()}%`;
        q = q.or(`display_address.ilike.${s},suburb.ilike.${s}`);
      }
      if (tab === "with_project") q = q.gt("project_count", 0);
      if (tab === "linked") q = q.gt("project_count", 0).gt("listing_count", 0);
      if (tab === "for_sale") q = q.eq("current_listing_type", "for_sale");
      if (tab === "sold") q = q.eq("current_listing_type", "sold");

      const { data, error } = await q.limit(5000);
      if (error) throw error;
      setMapProperties(data || []);
    } catch (err) {
      console.error("Map fetch failed:", err);
      setMapProperties([]);
    } finally {
      setMapLoading(false);
    }
  }, [search, tab, view]);
  useEffect(() => { fetchMapProperties(); }, [fetchMapProperties]);

  // Suburbs view fetch
  const fetchSuburbs = useCallback(async () => {
    if (view !== "suburbs") return;
    setLoading(true);
    try {
      let q = api._supabase.from("property_suburb_stats_v").select("*");
      if (search.trim()) {
        const s = `%${search.trim().toLowerCase()}%`;
        q = q.or(`suburb.ilike.${s},postcode.ilike.${s}`);
      }
      q = q.order(suburbSort, { ascending: false, nullsFirst: false }).limit(300);
      const { data, error } = await q;
      if (error) throw error;
      setSuburbs(data || []);
    } catch (err) {
      console.error("Suburbs fetch failed:", err);
      setSuburbs([]);
    } finally {
      setLoading(false);
    }
  }, [search, suburbSort, view]);
  useEffect(() => { fetchSuburbs(); }, [fetchSuburbs]);

  // Health stats (global, one-shot)
  useEffect(() => {
    (async () => {
      const { data } = await api._supabase.from("properties_health_v").select("*").maybeSingle();
      setStats(data);
    })();
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const onViewChange = (v) => { setView(v); setPage(0); };
  const onTabChange = (v) => { setTab(v); setPage(0); };
  const onSearchChange = (e) => { setSearch(e.target.value); setPage(0); };
  const refresh = () => {
    if (view === "list") fetchProperties();
    else if (view === "map") fetchMapProperties();
    else fetchSuburbs();
  };

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Home className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Properties</h1>
          <Badge variant="outline" className="text-[10px]">
            {view === "list" ? `${total.toLocaleString()} addresses` :
             view === "suburbs" ? `${suburbs.length.toLocaleString()} suburbs` :
             `${mapProperties.length.toLocaleString()} mapped`}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <ViewToggleBtn active={view === "list"} onClick={() => onViewChange("list")} icon={ListIcon} label="List" />
            <ViewToggleBtn active={view === "suburbs"} onClick={() => onViewChange("suburbs")} icon={Layers} label="Suburbs" />
            <ViewToggleBtn active={view === "map"} onClick={() => onViewChange("map")} icon={MapIcon} label="Map" />
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-7 h-8 w-56 text-sm"
              placeholder={view === "suburbs" ? "Search suburbs…" : "Search address, suburb, postcode…"}
              value={search}
              onChange={onSearchChange}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading || mapLoading}>
            <RefreshCw className={cn("h-3.5 w-3.5", (loading || mapLoading) && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Health stats */}
      {stats && view !== "map" && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCard label="Total properties" value={stats.total_properties} icon={Home} />
          <StatCard label="Linked" value={stats.linked_properties} icon={Tag} color="text-emerald-600" subtitle="project + listing" />
          <StatCard label="Project-only" value={stats.project_only_properties} icon={Camera} color="text-violet-600" subtitle="FlexStudios shoots" />
          <StatCard label="Listing-only" value={stats.listing_only_properties} icon={Building2} color="text-blue-600" subtitle="REA detected" />
        </div>
      )}

      {/* Filter tabs (list + map views) */}
      {view !== "suburbs" && (
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList className="bg-muted/40 flex-wrap h-auto">
            {FILTER_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="text-xs">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {/* Suburb-specific sort dropdown */}
      {view === "suburbs" && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Sort by:</span>
          {[
            { val: "total_properties", lbl: "Most properties" },
            { val: "our_shoots", lbl: "Most our shoots" },
            { val: "currently_for_sale", lbl: "Most for sale now" },
            { val: "avg_sold_price", lbl: "Highest avg sold" },
          ].map((o) => (
            <button
              key={o.val}
              onClick={() => setSuburbSort(o.val)}
              className={cn(
                "px-2 py-0.5 rounded-md transition-colors",
                suburbSort === o.val ? "bg-primary text-primary-foreground" : "bg-muted/60 hover:bg-muted"
              )}
            >
              {o.lbl}
            </button>
          ))}
        </div>
      )}

      {/* ─── Content ─────────────────────────────────────────────────────── */}
      {view === "list" && (
        <ListView
          properties={properties}
          loading={loading}
          total={total}
          page={page}
          setPage={setPage}
          totalPages={totalPages}
          hasSearch={!!search}
        />
      )}
      {view === "suburbs" && (
        <SuburbsView suburbs={suburbs} loading={loading} />
      )}
      {view === "map" && (
        <MapView properties={mapProperties} loading={mapLoading} />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function ViewToggleBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
      )}
    >
      <Icon className="h-3 w-3" />
      <span className="hidden sm:inline">{label}</span>
    </button>
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
          <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>
            {(typeof value === "number") ? value.toLocaleString() : value}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
          {subtitle && <p className="text-[9px] text-muted-foreground/60">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── List view ───────────────────────────────────────────────────────────── */

function ListView({ properties, loading, total, page, setPage, totalPages, hasSearch }) {
  return (
    <>
      <Card className="rounded-xl">
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading properties…
            </div>
          ) : properties.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Home className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No properties match this filter.</p>
              {hasSearch && <p className="text-xs mt-1">Try clearing the search.</p>}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {properties.map((p) => <PropertyRow key={p.id} property={p} />)}
            </div>
          )}
        </CardContent>
      </Card>
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <p>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>
              Previous
            </Button>
            <span>Page {page + 1} of {totalPages}</span>
            <Button variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function PropertyRow({ property }) {
  const facts = [];
  if (property.bedrooms) facts.push(`${property.bedrooms}br`);
  if (property.bathrooms) facts.push(`${property.bathrooms}ba`);
  if (property.parking) facts.push(`${property.parking}car`);
  const factsStr = facts.join(" · ");
  const state = getCurrentState(property);

  return (
    <Link
      to={`/PropertyDetails?key=${encodeURIComponent(property.property_key)}`}
      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
    >
      <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-md bg-muted overflow-hidden flex-shrink-0 border border-border/40">
        {property.hero_image ? (
          <img src={property.hero_image} alt="" className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <Home className="h-5 w-5" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{property.display_address}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {property.suburb}{property.postcode ? ` · ${property.postcode}` : ""}
          {factsStr && <> · {factsStr}</>}
          {property.property_type && <> · {property.property_type}</>}
        </p>
      </div>
      <div className="hidden sm:flex items-center gap-1.5 shrink-0">
        {property.project_count > 0 && (
          <Badge variant="outline" className="text-[10px] bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300">
            <Camera className="h-2.5 w-2.5 mr-1" /> {property.project_count}
          </Badge>
        )}
        {property.listing_count > 0 && (
          <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300">
            <Building2 className="h-2.5 w-2.5 mr-1" /> {property.listing_count}
          </Badge>
        )}
      </div>
      <div className="hidden md:flex flex-col items-end gap-0.5 shrink-0 w-40">
        {state ? (
          <>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className={cn("text-[10px]", state.cls)}>
                {state.label}
              </Badge>
              {(property.current_asking_price || property.last_sold_price) && (
                <span className="font-semibold text-xs tabular-nums">
                  {fmtPrice(property.current_asking_price || property.last_sold_price)}
                </span>
              )}
            </div>
            {state.timeStr && <span className="text-[9px] text-muted-foreground">{state.timeStr}</span>}
          </>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
    </Link>
  );
}

function getCurrentState(property) {
  const now = Date.now();
  const dayMs = 86400000;
  const listedDate = property.current_listed_date ? new Date(property.current_listed_date).getTime() : null;
  const soldDate = property.last_sold_at ? new Date(property.last_sold_at).getTime() : null;

  if (property.current_listing_type && listedDate && (now - listedDate) < 90 * dayMs) {
    return {
      label: TYPE_LABEL[property.current_listing_type] || property.current_listing_type,
      cls: TYPE_BADGE[property.current_listing_type],
      timeStr: fmtRelative(property.current_listed_date),
    };
  }
  if (soldDate && (now - soldDate) < 180 * dayMs) {
    return {
      label: "Sold",
      cls: TYPE_BADGE.sold,
      timeStr: fmtRelative(property.last_sold_at),
    };
  }
  if (property.current_listing_type) {
    return {
      label: `Was ${TYPE_LABEL[property.current_listing_type] || property.current_listing_type}`,
      cls: "bg-muted/60 text-muted-foreground border-transparent",
      timeStr: listedDate ? fmtRelative(property.current_listed_date) : null,
    };
  }
  return null;
}

/* ── Suburbs view ────────────────────────────────────────────────────────── */

function SuburbsView({ suburbs, loading }) {
  if (loading) {
    return (
      <Card><CardContent className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading suburbs…
      </CardContent></Card>
    );
  }
  if (suburbs.length === 0) {
    return (
      <Card><CardContent className="py-12 text-center text-muted-foreground">
        <Layers className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p className="text-sm">No suburbs match this search.</p>
      </CardContent></Card>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {suburbs.map((s) => <SuburbCard key={s.suburb_key} suburb={s} />)}
    </div>
  );
}

function SuburbCard({ suburb: s }) {
  const flexShare = s.total_properties > 0
    ? Math.round((s.our_shoots / s.total_properties) * 100)
    : 0;

  return (
    <Link
      to={`/Properties?view=list&search=${encodeURIComponent(s.suburb)}`}
      className="block"
    >
      <Card className="rounded-xl hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardContent className="p-3 space-y-2">
          {/* Header */}
          <div>
            <p className="text-sm font-semibold truncate">{s.suburb}</p>
            <p className="text-[10px] text-muted-foreground">
              {s.state || "NSW"}{s.postcode ? ` · ${s.postcode}` : ""}
            </p>
          </div>

          {/* Headline stat: our share */}
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tabular-nums">{s.our_shoots}</span>
            <span className="text-xs text-muted-foreground">of {s.total_properties} = {flexShare}%</span>
          </div>
          <p className="text-[10px] text-muted-foreground -mt-1">FlexStudios shoot share</p>

          {/* Progress bar */}
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 rounded-full transition-all"
              style={{ width: `${Math.min(100, flexShare)}%` }}
            />
          </div>

          {/* Bottom stats */}
          <div className="grid grid-cols-3 gap-1 pt-1 text-center">
            <Stat label="For Sale" value={s.currently_for_sale} color="text-blue-600" />
            <Stat label="For Rent" value={s.currently_for_rent} color="text-purple-600" />
            <Stat label="Sales logged" value={s.with_sales} color="text-emerald-600" />
          </div>

          {/* Avg prices */}
          {(s.avg_asking_price || s.avg_sold_price) && (
            <div className="pt-1 border-t border-border/60 flex items-center justify-between text-[10px] text-muted-foreground">
              {s.avg_asking_price && (
                <span>Avg asking: <span className="font-semibold text-foreground">{fmtPrice(s.avg_asking_price)}</span></span>
              )}
              {s.avg_sold_price && (
                <span>Avg sold: <span className="font-semibold text-foreground">{fmtPrice(s.avg_sold_price)}</span></span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <p className={cn("text-sm font-bold tabular-nums leading-none", color || "text-foreground")}>
        {value || 0}
      </p>
      <p className="text-[9px] text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

/* ── Map view ────────────────────────────────────────────────────────────── */

function MapView({ properties, loading }) {
  return (
    <Card className="rounded-xl overflow-hidden">
      <CardContent className="p-0">
        {loading && (
          <div className="absolute top-3 right-3 z-[1000] bg-card rounded-md shadow-md px-2 py-1 flex items-center gap-1 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        <div className="h-[calc(100vh-280px)] min-h-[500px] w-full relative">
          <MapContainer center={SYDNEY_CENTER} zoom={11} style={{ height: "100%", width: "100%" }} className="z-0">
            <TileLayer url={TILE_URL} attribution={TILE_ATTR} />
            <MarkerClusterGroup chunkedLoading>
              {properties.map((p) => (
                <PropertyMarker key={p.id} property={p} />
              ))}
            </MarkerClusterGroup>
          </MapContainer>
        </div>
        <div className="px-3 py-2 border-t border-border/60 flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-500" /> FlexStudios shoot</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Linked (project + listing)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> For sale</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-400" /> Listing only</span>
        </div>
      </CardContent>
    </Card>
  );
}

function PropertyMarker({ property }) {
  const p = property;
  const color =
    (p.project_count > 0 && p.listing_count > 0) ? "#10b981" :  // emerald — linked
    (p.project_count > 0) ? "#8b5cf6" :                          // violet — our shoot
    (p.current_listing_type === "for_sale") ? "#3b82f6" :        // blue — for sale
    "#9ca3af";                                                   // gray — listing only

  return (
    <CircleMarker
      center={[p.latitude, p.longitude]}
      radius={6}
      pathOptions={{ color, fillColor: color, fillOpacity: 0.7, weight: 1 }}
    >
      <Popup>
        <div className="space-y-1 text-xs min-w-[200px]">
          {p.hero_image && (
            <img src={p.hero_image} className="w-full h-20 object-cover rounded mb-1" alt="" />
          )}
          <p className="font-semibold">{p.display_address}</p>
          <p className="text-muted-foreground">{p.suburb}</p>
          <div className="flex items-center gap-1 flex-wrap">
            {p.project_count > 0 && (
              <Badge variant="outline" className="text-[9px] bg-violet-50 text-violet-700 border-violet-200">
                <Camera className="h-2.5 w-2.5 mr-0.5" /> {p.project_count} shot{p.project_count !== 1 ? 's' : ''}
              </Badge>
            )}
            {p.listing_count > 0 && (
              <Badge variant="outline" className="text-[9px] bg-blue-50 text-blue-700 border-blue-200">
                <Building2 className="h-2.5 w-2.5 mr-0.5" /> {p.listing_count} listing{p.listing_count !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          {(p.current_asking_price || p.last_sold_price) && (
            <p className="font-semibold tabular-nums">
              {fmtPrice(p.current_asking_price || p.last_sold_price)}
              <span className="text-[10px] text-muted-foreground ml-1">
                {p.current_listing_type ? TYPE_LABEL[p.current_listing_type] : "last sold"}
              </span>
            </p>
          )}
          <Link to={`/PropertyDetails?key=${encodeURIComponent(p.property_key)}`} className="inline-block text-primary text-[11px] hover:underline pt-1">
            Open property →
          </Link>
        </div>
      </Popup>
    </CircleMarker>
  );
}

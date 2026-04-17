/**
 * Properties — index page
 *
 * Browse every physical address that's ever appeared in either:
 *   - pulse_listings (REA scraping)
 *   - projects (FlexStudios shoots)
 *
 * Backed by property_full_v view (joins on property_key).
 * One row per physical property regardless of how many campaigns/projects.
 */
import React, { useState, useEffect, useMemo, useCallback } from "react";
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
  Filter, Building2, Users, RefreshCw, Bed, Bath, Car,
} from "lucide-react";

const PAGE_SIZE = 50;

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
  { value: "all",          label: "All",                badge: null },
  { value: "with_project", label: "Mine (have project)", badge: "blue" },
  { value: "linked",       label: "Linked (project + listing)", badge: "emerald" },
  { value: "multi_listing", label: "Multi-campaign",     badge: "amber" },
  { value: "for_sale",      label: "Currently For Sale", badge: "blue" },
  { value: "sold",          label: "Recently Sold",      badge: "emerald" },
];

export default function Properties() {
  const [properties, setProperties] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const [page, setPage] = useState(0);
  const [stats, setStats] = useState(null);

  const fetchProperties = useCallback(async () => {
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

      q = q
        .order("last_seen_at", { ascending: false, nullsFirst: false })
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
  }, [search, tab, page]);

  useEffect(() => { fetchProperties(); }, [fetchProperties]);

  // Health stats from properties_health_v (one-shot)
  useEffect(() => {
    (async () => {
      const { data } = await api._supabase.from("properties_health_v").select("*").maybeSingle();
      setStats(data);
    })();
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const onTabChange = (v) => { setTab(v); setPage(0); };
  const onSearchChange = (e) => { setSearch(e.target.value); setPage(0); };

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Home className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Properties</h1>
          <Badge variant="outline" className="text-[10px]">
            {total.toLocaleString()} addresses
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-7 h-8 w-64 text-sm"
              placeholder="Search address, suburb, postcode…"
              value={search}
              onChange={onSearchChange}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={fetchProperties} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Health stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCard label="Total properties" value={stats.total_properties} icon={Home} />
          <StatCard label="Linked" value={stats.linked_properties} icon={Tag} color="text-emerald-600" subtitle="project + listing" />
          <StatCard label="Project-only" value={stats.project_only_properties} icon={Camera} color="text-violet-600" subtitle="FlexStudios shoots" />
          <StatCard label="Listing-only" value={stats.listing_only_properties} icon={Building2} color="text-blue-600" subtitle="REA detected" />
        </div>
      )}

      {/* Filter tabs */}
      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList className="bg-muted/40 flex-wrap h-auto">
          {FILTER_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="text-xs">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Results */}
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
              {search && <p className="text-xs mt-1">Try clearing the search.</p>}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {properties.map((p) => (
                <PropertyRow key={p.id} property={p} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
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
          <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>
            {(value || 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
          {subtitle && <p className="text-[9px] text-muted-foreground/60">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Smart "currently" state — distinguishes recent active listings from stale ones.
 * Returns { label, color, isFresh } for the row's status badge.
 */
function getCurrentState(property) {
  const now = Date.now();
  const dayMs = 86400000;
  const listedDate = property.current_listed_date ? new Date(property.current_listed_date).getTime() : null;
  const soldDate = property.last_sold_at ? new Date(property.last_sold_at).getTime() : null;

  // If currently for_sale/rent and listed within 90 days → "active"
  if (property.current_listing_type && listedDate && (now - listedDate) < 90 * dayMs) {
    return {
      label: TYPE_LABEL[property.current_listing_type] || property.current_listing_type,
      cls: TYPE_BADGE[property.current_listing_type],
      isFresh: true,
      timeStr: fmtRelative(property.current_listed_date),
    };
  }

  // Sold recently (within 6 months)?
  if (soldDate && (now - soldDate) < 180 * dayMs) {
    return {
      label: "Sold",
      cls: TYPE_BADGE.sold,
      isFresh: true,
      timeStr: fmtRelative(property.last_sold_at),
    };
  }

  // Has any listing but it's old
  if (property.current_listing_type) {
    return {
      label: `Was ${TYPE_LABEL[property.current_listing_type] || property.current_listing_type}`,
      cls: "bg-muted/60 text-muted-foreground border-transparent",
      isFresh: false,
      timeStr: listedDate ? fmtRelative(property.current_listed_date) : null,
    };
  }

  return null;
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
      {/* Thumbnail */}
      <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-md bg-muted overflow-hidden flex-shrink-0 border border-border/40">
        {property.hero_image ? (
          <img
            src={property.hero_image}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement.innerHTML = '<div class=\"w-full h-full flex items-center justify-center text-muted-foreground/40\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><polyline points=\"9 22 9 12 15 12 15 22\"/></svg></div>'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <Home className="h-5 w-5" />
          </div>
        )}
      </div>

      {/* Address */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate flex items-center gap-1.5">
          {property.display_address}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {property.suburb}{property.postcode ? ` · ${property.postcode}` : ""}
          {factsStr && <> · {factsStr}</>}
          {property.property_type && <> · {property.property_type}</>}
        </p>
      </div>

      {/* Listings + Projects badges */}
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

      {/* Current state — smart label */}
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
            {state.timeStr && (
              <span className="text-[9px] text-muted-foreground">{state.timeStr}</span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </div>

      <ArrowRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
    </Link>
  );
}

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
  Filter, Building2, Users, RefreshCw,
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

function PropertyRow({ property }) {
  return (
    <Link
      to={`/PropertyDetails?key=${encodeURIComponent(property.property_key)}`}
      className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors"
    >
      {/* Address */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate flex items-center gap-1.5">
          <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
          {property.display_address}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {property.suburb}{property.postcode ? ` · ${property.postcode}` : ""}{" · "}
          first seen {fmtRelative(property.first_seen_at)}
        </p>
      </div>

      {/* Listings + Projects badges */}
      <div className="flex items-center gap-1.5 shrink-0">
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

      {/* Current state */}
      <div className="hidden md:flex items-center gap-2 text-xs shrink-0 w-44 justify-end">
        {property.current_listing_type ? (
          <>
            <Badge variant="outline" className={cn("text-[10px]", TYPE_BADGE[property.current_listing_type] || "")}>
              {TYPE_LABEL[property.current_listing_type] || property.current_listing_type}
            </Badge>
            {property.current_asking_price && (
              <span className="font-semibold tabular-nums">{fmtPrice(property.current_asking_price)}</span>
            )}
          </>
        ) : property.last_sold_price ? (
          <>
            <span className="text-muted-foreground">Sold</span>
            <span className="font-semibold tabular-nums">{fmtPrice(property.last_sold_price)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      <ArrowRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
    </Link>
  );
}

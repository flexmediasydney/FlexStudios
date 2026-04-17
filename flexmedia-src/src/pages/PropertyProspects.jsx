/**
 * PropertyProspects — the prospecting opportunities page
 *
 * Shows properties we've previously shot that are now listed by a DIFFERENT
 * agent — prime targets for case-study outreach (show them our prior work
 * vs their current media).
 *
 * Data source: property_prospects_v
 *
 * Sort options:
 *   - Most recent listing
 *   - Most of our properties taken (agent-level concentration)
 *   - Highest asking price
 */
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Target, Search, MapPin, Camera, Building2, ExternalLink, Loader2,
  ArrowRight, Home, RefreshCw, TrendingUp, AlertCircle, Users, Zap,
  Mail, Phone, Crosshair,
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
  for_sale: "bg-blue-50 text-blue-700 border-blue-200",
  for_rent: "bg-purple-50 text-purple-700 border-purple-200",
  sold: "bg-emerald-50 text-emerald-700 border-emerald-200",
  under_contract: "bg-amber-50 text-amber-700 border-amber-200",
};
const TYPE_LABEL = {
  for_sale: "For Sale",
  for_rent: "For Rent",
  sold: "Sold",
  under_contract: "Under Contract",
};

const SORT_OPTIONS = [
  { value: "recent",       label: "Most recent listing", col: "current_listed_date" },
  { value: "concentration", label: "Agent concentration", col: "prospect_agent_our_properties_count" },
  { value: "price",         label: "Highest asking",      col: "current_asking_price" },
];

export default function PropertyProspects() {
  const [prospects, setProspects] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [filter, setFilter] = useState("all"); // all, fresh (last 30d), not_in_crm

  const fetchProspects = useCallback(async () => {
    setLoading(true);
    try {
      const sortCol = SORT_OPTIONS.find((s) => s.value === sort)?.col || "current_listed_date";
      let q = api._supabase.from("property_prospects_v").select("*", { count: "exact" });

      if (search.trim()) {
        const s = `%${search.trim().toLowerCase()}%`;
        q = q.or(`display_address.ilike.${s},suburb.ilike.${s},prospect_agent_name.ilike.${s},prospect_agency_name.ilike.${s}`);
      }
      if (filter === "fresh") {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
        q = q.gte("current_listed_date", thirtyDaysAgo);
      }
      if (filter === "not_in_crm") {
        q = q.is("prospect_agent_crm_id", null);
      }

      q = q.order(sortCol, { ascending: false, nullsFirst: false }).limit(PAGE_SIZE);
      const { data, error, count } = await q;
      if (error) throw error;
      setProspects(data || []);
      setTotal(count || 0);
    } catch (err) {
      console.error("Prospects fetch failed:", err);
      setProspects([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, sort, filter]);

  useEffect(() => { fetchProspects(); }, [fetchProspects]);

  // Top prospect agents (aggregate concentration)
  const topProspectAgents = useMemo(() => {
    const map = new Map();
    for (const p of prospects) {
      if (!p.prospect_agent_rea_id) continue;
      if (!map.has(p.prospect_agent_rea_id)) {
        map.set(p.prospect_agent_rea_id, {
          id: p.prospect_agent_rea_id,
          name: p.prospect_agent_name,
          agency: p.prospect_agency_name,
          phone: p.prospect_agent_phone,
          crm_id: p.prospect_agent_crm_id,
          count: 0,
          properties: [],
        });
      }
      const entry = map.get(p.prospect_agent_rea_id);
      entry.count++;
      entry.properties.push(p.display_address);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, 5);
  }, [prospects]);

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-red-500" />
          <h1 className="text-xl font-bold tracking-tight">Prospect Opportunities</h1>
          <Badge variant="outline" className="text-[10px]">
            {total} target{total !== 1 ? "s" : ""}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-7 h-8 w-64 text-sm"
              placeholder="Search address, agent, agency…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={fetchProspects} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Intro / explainer */}
      <Card className="rounded-xl bg-red-50/40 dark:bg-red-950/20 border-red-200/60">
        <CardContent className="p-3 flex items-start gap-3">
          <Crosshair className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div className="flex-1 text-xs">
            <p className="font-semibold mb-0.5">Properties we've previously shot — now listed by a different agent</p>
            <p className="text-muted-foreground leading-relaxed">
              These are prospects. Compare our prior media with their current media, pitch a case study,
              convert the new agent to a FlexStudios client.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Top prospect agents summary */}
      {topProspectAgents.length > 0 && (
        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Top Prospect Agents (by properties taken from us)
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {topProspectAgents.map((a) => (
              <div key={a.id} className="flex items-center gap-2 p-2 rounded-md border border-border/60">
                <div className="w-8 h-8 rounded-full bg-red-50 text-red-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                  {(a.name || "?").charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{a.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{a.agency}</p>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {a.count} taken
                </Badge>
                {!a.crm_id && (
                  <Badge variant="outline" className="text-[9px] bg-amber-50 text-amber-700 border-amber-200 shrink-0">
                    Not in CRM
                  </Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-muted-foreground">Filter:</span>
        {[
          { val: "all", lbl: "All" },
          { val: "fresh", lbl: "Listed in last 30d" },
          { val: "not_in_crm", lbl: "Agent not in CRM" },
        ].map((o) => (
          <button
            key={o.val}
            onClick={() => setFilter(o.val)}
            className={cn(
              "px-2 py-0.5 rounded-md transition-colors",
              filter === o.val ? "bg-primary text-primary-foreground" : "bg-muted/60 hover:bg-muted"
            )}
          >
            {o.lbl}
          </button>
        ))}
        <span className="text-muted-foreground ml-2">Sort:</span>
        {SORT_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => setSort(o.value)}
            className={cn(
              "px-2 py-0.5 rounded-md transition-colors",
              sort === o.value ? "bg-primary text-primary-foreground" : "bg-muted/60 hover:bg-muted"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* Results */}
      {loading ? (
        <Card><CardContent className="py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading prospects…
        </CardContent></Card>
      ) : prospects.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">
          <Target className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-medium">No prospect opportunities right now.</p>
          <p className="text-xs mt-1">
            As REA scrapes detect properties you've shot listing with new agents, they'll appear here.
          </p>
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {prospects.map((p) => <ProspectCard key={p.id} prospect={p} />)}
        </div>
      )}
    </div>
  );
}

function ProspectCard({ prospect: p }) {
  const daysSinceListing = p.current_listed_date
    ? Math.floor((Date.now() - new Date(p.current_listed_date).getTime()) / 86400000)
    : null;
  const isFresh = daysSinceListing !== null && daysSinceListing < 30;

  return (
    <Card className={cn(
      "rounded-xl overflow-hidden",
      isFresh && "ring-1 ring-red-500/30"
    )}>
      <CardContent className="p-0">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-0">
          {/* Hero image */}
          <Link
            to={`/PropertyDetails?key=${encodeURIComponent(p.property_key)}`}
            className="lg:col-span-3 bg-muted h-40 lg:h-auto overflow-hidden group block"
          >
            {p.hero_image ? (
              <img src={p.hero_image} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }} />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground/30">
                <Home className="h-8 w-8" />
              </div>
            )}
          </Link>

          {/* Address + property facts */}
          <div className="lg:col-span-4 p-3 flex flex-col gap-1.5 justify-between border-b lg:border-b-0 lg:border-r border-border/60">
            <div>
              <p className="text-xs font-semibold flex items-center gap-1.5">
                <MapPin className="h-3 w-3 text-muted-foreground" />
                {p.display_address}
              </p>
              <p className="text-[10px] text-muted-foreground ml-4">
                {p.suburb}{p.postcode ? ` · ${p.postcode}` : ""}
                {p.property_type && ` · ${p.property_type}`}
                {p.bedrooms && ` · ${p.bedrooms}br`}
                {p.bathrooms && `/${p.bathrooms}ba`}
                {p.parking && `/${p.parking}car`}
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="outline" className={cn("text-[10px]", TYPE_BADGE[p.current_listing_type])}>
                {TYPE_LABEL[p.current_listing_type] || p.current_listing_type}
              </Badge>
              {(p.current_asking_price || p.current_sold_price) && (
                <span className="text-sm font-bold tabular-nums">
                  {fmtPrice(p.current_asking_price || p.current_sold_price)}
                </span>
              )}
              {isFresh && (
                <Badge variant="outline" className="text-[9px] bg-red-50 text-red-700 border-red-200 animate-pulse">
                  🔥 Fresh — {fmtRelative(p.current_listed_date)}
                </Badge>
              )}
            </div>
            <Link
              to={`/PropertyDetails?key=${encodeURIComponent(p.property_key)}`}
              className="text-[10px] text-primary hover:underline inline-flex items-center gap-1 mt-1"
            >
              View property history <ArrowRight className="h-2.5 w-2.5" />
            </Link>
          </div>

          {/* US (our previous work) */}
          <div className="lg:col-span-2 p-3 bg-violet-50/30 dark:bg-violet-950/10 border-b lg:border-b-0 lg:border-r border-border/60 space-y-1">
            <p className="text-[9px] uppercase tracking-widest text-violet-700 dark:text-violet-400 font-semibold">Our work</p>
            <Link to={`/ProjectDetails?id=${p.project_id}`} className="block hover:underline">
              <p className="text-xs font-medium truncate flex items-center gap-1">
                <Camera className="h-3 w-3" /> {p.project_package_name || "Project"}
              </p>
              <p className="text-[10px] text-muted-foreground">{fmtDate(p.project_shoot_date)}</p>
            </Link>
            <p className="text-[10px]">
              <span className="text-muted-foreground">Agent:</span>{" "}
              <span className="font-medium">{p.project_agent_name || "—"}</span>
            </p>
            {p.project_agency_name && (
              <p className="text-[10px] text-muted-foreground truncate">{p.project_agency_name}</p>
            )}
          </div>

          {/* THEM (the prospect) */}
          <div className="lg:col-span-3 p-3 bg-red-50/30 dark:bg-red-950/10 space-y-1.5">
            <p className="text-[9px] uppercase tracking-widest text-red-700 dark:text-red-400 font-semibold flex items-center gap-1">
              <Target className="h-2.5 w-2.5" /> Prospect target
            </p>
            <div>
              <p className="text-xs font-semibold flex items-center gap-1">
                {p.prospect_agent_name}
                {!p.prospect_agent_crm_id && (
                  <Badge variant="outline" className="text-[8px] bg-amber-50 text-amber-700 border-amber-200">
                    Not in CRM
                  </Badge>
                )}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">{p.prospect_agency_name}</p>
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              {p.prospect_agent_phone && (
                <a href={`tel:${p.prospect_agent_phone}`} className="flex items-center gap-1 text-primary hover:underline">
                  <Phone className="h-2.5 w-2.5" /> {p.prospect_agent_phone}
                </a>
              )}
            </div>
            {p.prospect_agent_our_properties_count > 1 && (
              <div className="flex items-center gap-1 text-[10px] text-red-700 dark:text-red-400">
                <TrendingUp className="h-2.5 w-2.5" />
                Has taken <span className="font-bold">{p.prospect_agent_our_properties_count}</span> of our properties
              </div>
            )}
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              {p.prospect_listing_url && (
                <a
                  href={p.prospect_listing_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline inline-flex items-center gap-1"
                >
                  <ExternalLink className="h-2.5 w-2.5" /> Their listing
                </a>
              )}
              {p.prospect_agent_crm_id && (
                <Link
                  to={`/PersonDetails?id=${p.prospect_agent_crm_id}`}
                  className="text-[10px] text-primary hover:underline inline-flex items-center gap-1"
                >
                  <Users className="h-2.5 w-2.5" /> CRM profile
                </Link>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

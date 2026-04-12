import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import AgentSearch from "@/components/clientMonitor/AgentSearch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search, ExternalLink, Camera, Film, Map,
  CheckCircle2, AlertTriangle, XCircle, Home, Bed,
  Bath, Car, Ruler, Calendar, TrendingUp, Eye, ArrowRight,
  RefreshCw, Info, Layers, Loader2
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Coverage Score Ring (SVG)                                         */
/* ------------------------------------------------------------------ */
function CoverageRing({ percent, size = 120, strokeWidth = 10 }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  const color =
    percent >= 75 ? "text-emerald-500" : percent >= 50 ? "text-amber-500" : "text-red-500";
  const bgColor =
    percent >= 75 ? "text-emerald-500/15" : percent >= 50 ? "text-amber-500/15" : "text-red-500/15";

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className={cn("stroke-current", bgColor)}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn("stroke-current transition-all duration-700 ease-out", color)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-2xl font-bold tabular-nums", color.replace("text-", "text-"))}>{percent}%</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Coverage</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Quality Badge                                                     */
/* ------------------------------------------------------------------ */
function QualityBadge({ score, label }) {
  if (score == null) return null;
  const config = {
    Professional: { color: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: "border-emerald-400" },
    Standard:     { color: "bg-blue-100 text-blue-700 border-blue-200",         icon: "border-blue-400" },
    Basic:        { color: "bg-amber-100 text-amber-700 border-amber-200",       icon: "border-amber-400" },
    Amateur:      { color: "bg-red-100 text-red-700 border-red-200",             icon: "border-red-400" },
  };
  const c = config[label] || config.Basic;
  return (
    <Badge variant="outline" className={cn("text-xs font-medium border", c.color)}>
      <Camera className="h-3 w-3 mr-1" />
      {score}/100 {label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/*  Status Badge                                                      */
/* ------------------------------------------------------------------ */
function ListingStatusBadge({ status }) {
  if (!status) return null;
  const map = {
    for_sale:  { label: "For Sale",  className: "bg-blue-100 text-blue-700 border-blue-200" },
    sold:      { label: "Sold",      className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
    withdrawn: { label: "Withdrawn", className: "bg-slate-100 text-slate-600 border-slate-200" },
  };
  const c = map[status] || { label: status, className: "bg-slate-100 text-slate-600 border-slate-200" };
  return <Badge variant="outline" className={cn("text-xs border", c.className)}>{c.label}</Badge>;
}

/* ------------------------------------------------------------------ */
/*  Property detail chips                                             */
/* ------------------------------------------------------------------ */
function PropertyChips({ listing }) {
  const chips = [];
  if (listing.bedrooms != null) chips.push({ icon: Bed, value: listing.bedrooms, label: "Bed" });
  if (listing.bathrooms != null) chips.push({ icon: Bath, value: listing.bathrooms, label: "Bath" });
  if (listing.carspaces != null) chips.push({ icon: Car, value: listing.carspaces, label: "Car" });
  if (listing.land_area_sqm != null) chips.push({ icon: Ruler, value: `${listing.land_area_sqm}m\u00B2`, label: "Land" });
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      {chips.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          <c.icon className="h-3.5 w-3.5" />
          {c.value}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Media icons row                                                   */
/* ------------------------------------------------------------------ */
function MediaIcons({ listing }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Camera className="h-3.5 w-3.5" />
        {listing.photo_count ?? 0}
      </span>
      {listing.has_floorplan && (
        <span className="inline-flex items-center gap-1 text-blue-600">
          <Layers className="h-3.5 w-3.5" /> Floorplan
        </span>
      )}
      {listing.has_video && (
        <span className="inline-flex items-center gap-1 text-purple-600">
          <Film className="h-3.5 w-3.5" /> Video
        </span>
      )}
      {listing.has_virtual_tour && (
        <span className="inline-flex items-center gap-1 text-indigo-600">
          <Eye className="h-3.5 w-3.5" /> Tour
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Gap Listing Card                                                  */
/* ------------------------------------------------------------------ */
function GapCard({ listing }) {
  return (
    <Card className="overflow-hidden border-l-4 border-l-amber-400 hover:shadow-md transition-shadow">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground truncate">{listing.address}</p>
            {listing.headline && (
              <p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">{listing.headline}</p>
            )}
          </div>
          {listing.display_price && (
            <Badge className="bg-slate-900 text-white hover:bg-slate-800 shrink-0 text-sm font-semibold">
              {listing.display_price}
            </Badge>
          )}
        </div>

        <PropertyChips listing={listing} />

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <QualityBadge score={listing.photo_quality_score} label={listing.quality_label} />
            <MediaIcons listing={listing} />
          </div>
          {listing.date_listed && (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {new Date(listing.date_listed).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
            </span>
          )}
        </div>

        <div className="pt-2 border-t border-dashed border-amber-200">
          <div className="flex items-center gap-2 text-amber-700">
            <TrendingUp className="h-4 w-4" />
            <span className="text-sm font-medium">Potential revenue opportunity</span>
            <ArrowRight className="h-3.5 w-3.5 ml-auto" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Matched Listing Card                                              */
/* ------------------------------------------------------------------ */
function MatchedCard({ match }) {
  const { listing, project } = match;
  return (
    <Card className="overflow-hidden border-l-4 border-l-emerald-400 hover:shadow-md transition-shadow">
      <CardContent className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
          {/* Domain listing side */}
          <div className="p-5 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider bg-blue-50 text-blue-700 border-blue-200">
                Domain
              </Badge>
              <ListingStatusBadge status={listing.status} />
            </div>
            <p className="font-semibold text-foreground text-sm">{listing.address}</p>
            {listing.display_price && (
              <p className="text-sm font-medium text-foreground">{listing.display_price}</p>
            )}
            <PropertyChips listing={listing} />
            <div className="flex items-center gap-2 flex-wrap">
              <QualityBadge score={listing.photo_quality_score} label={listing.quality_label} />
              <MediaIcons listing={listing} />
            </div>
          </div>

          {/* FlexMedia project side */}
          <div className="p-5 space-y-2 bg-emerald-50/30">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider bg-emerald-50 text-emerald-700 border-emerald-200">
                FlexMedia
              </Badge>
              {project.status && (
                <Badge variant="outline" className="text-xs capitalize">
                  {project.status.replace(/_/g, " ")}
                </Badge>
              )}
            </div>
            <p className="font-semibold text-foreground text-sm">{project.property_address || project.title}</p>
            {project.shoot_date && (
              <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Shot {new Date(project.shoot_date).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
              </p>
            )}
            <div className="pt-2">
              <Link
                to={createPageUrl(`ProjectDetails?id=${project.id}`)}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:text-emerald-900 transition-colors"
              >
                View Project <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </div>

        {/* Matched connector */}
        <div className="hidden md:flex items-center justify-center -mt-px">
          <div className="flex items-center gap-1.5 bg-emerald-100 text-emerald-700 rounded-full px-3 py-1 text-xs font-medium -translate-y-4 shadow-sm border border-emerald-200">
            <CheckCircle2 className="h-3.5 w-3.5" /> Matched
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  All Listings Table                                                */
/* ------------------------------------------------------------------ */
function AllListingsTable({ listings, matches }) {
  const matchedIds = useMemo(
    () => new Set((matches || []).map((m) => m.listing?.domain_listing_id)),
    [matches]
  );

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/50 border-b border-border text-left">
            <th className="px-4 py-3 font-medium text-muted-foreground">Address</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Price</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Beds</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Baths</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Cars</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Photos</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Quality</th>
            <th className="px-4 py-3 font-medium text-muted-foreground text-center">Match</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {(listings || []).map((l, i) => {
            const isMatched = matchedIds.has(l.domain_listing_id);
            return (
              <tr key={l.domain_listing_id || i} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-medium text-foreground max-w-[280px] truncate">{l.address}</td>
                <td className="px-4 py-3"><ListingStatusBadge status={l.status} /></td>
                <td className="px-4 py-3 text-foreground whitespace-nowrap">{l.display_price || "--"}</td>
                <td className="px-4 py-3 text-center tabular-nums">{l.bedrooms ?? "--"}</td>
                <td className="px-4 py-3 text-center tabular-nums">{l.bathrooms ?? "--"}</td>
                <td className="px-4 py-3 text-center tabular-nums">{l.carspaces ?? "--"}</td>
                <td className="px-4 py-3 text-center tabular-nums">{l.photo_count ?? 0}</td>
                <td className="px-4 py-3">
                  <QualityBadge score={l.photo_quality_score} label={l.quality_label} />
                </td>
                <td className="px-4 py-3 text-center">
                  {isMatched ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 className="h-4 w-4" /> Matched
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-600">
                      <AlertTriangle className="h-4 w-4" /> Gap
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(!listings || listings.length === 0) && (
        <div className="text-center py-12 text-muted-foreground text-sm">No listings found</div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  MAIN PAGE                                                         */
/* ================================================================== */
export default function ClientMonitor() {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [activeTab, setActiveTab] = useState("gaps");

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["domain-monitor", selectedAgent?.id],
    queryFn: async () => {
      const res = await api.functions.invoke("domainAgentMonitor", { agent_id: selectedAgent.id });
      return res?.data || res || {};
    },
    enabled: !!selectedAgent?.id,
    staleTime: 5 * 60 * 1000,
  });

  const stats = data?.stats || {};
  const agent = data?.agent || selectedAgent || {};
  const gaps = data?.gaps || [];
  const matches = data?.matches || [];
  const unmatchedProjects = data?.unmatched_projects || [];
  const allListings = data?.all_listings || [];
  const dataSource = data?.data_source;

  /* ---------------------------------------------------------------- */
  /*  Phase 1: Agent Selection                                        */
  /* ---------------------------------------------------------------- */
  if (!selectedAgent) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
        <div className="max-w-2xl mx-auto pt-12">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-primary/10 mb-4">
              <Search className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-4xl font-bold text-foreground mb-2">Client Monitor</h1>
            <p className="text-muted-foreground text-lg">
              Select an agent to view their Domain listing coverage
            </p>
          </div>

          <Card className="p-8 shadow-lg border-0 bg-white">
            <AgentSearch onSelect={setSelectedAgent} />
          </Card>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Phase 2: Dashboard                                              */
  /* ---------------------------------------------------------------- */
  const coveragePct = stats.coverage_pct ?? 0;
  const coverageColor =
    coveragePct >= 75 ? "emerald" : coveragePct >= 50 ? "amber" : "red";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto p-6 space-y-6">

        {/* -------------------------------------------------------- */}
        {/*  Top Bar                                                  */}
        {/* -------------------------------------------------------- */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-5">
            <CoverageRing percent={coveragePct} size={80} strokeWidth={7} />
            <div>
              <h1 className="text-2xl font-bold text-foreground leading-tight">
                {agent.name || selectedAgent.name}
              </h1>
              {(agent.agency || selectedAgent.current_agency_name) && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  {agent.agency || selectedAgent.current_agency_name}
                </p>
              )}
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {agent.domain_url && (
                  <a
                    href={agent.domain_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" /> Domain Profile
                  </a>
                )}
                {dataSource && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] uppercase tracking-wider font-semibold border",
                      dataSource === "domain_api"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-amber-50 text-amber-700 border-amber-200"
                    )}
                  >
                    {dataSource === "domain_api" ? "Live" : "Simulation"}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="gap-1.5"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedAgent(null);
                setActiveTab("gaps");
              }}
            >
              Change Agent
            </Button>
          </div>
        </div>

        {/* -------------------------------------------------------- */}
        {/*  Loading state                                            */}
        {/* -------------------------------------------------------- */}
        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center space-y-3">
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">Scanning Domain listings...</p>
            </div>
          </div>
        )}

        {!isLoading && data && (
          <>
            {/* ------------------------------------------------------ */}
            {/*  Stats Strip                                            */}
            {/* ------------------------------------------------------ */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Domain Listings</p>
                      <p className="text-3xl font-bold text-blue-600 tabular-nums mt-1">{stats.domain_listings ?? 0}</p>
                    </div>
                    <div className="h-11 w-11 rounded-xl bg-blue-100 flex items-center justify-center">
                      <Home className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">FlexMedia Projects</p>
                      <p className="text-3xl font-bold text-emerald-600 tabular-nums mt-1">{stats.flexmedia_projects ?? 0}</p>
                    </div>
                    <div className="h-11 w-11 rounded-xl bg-emerald-100 flex items-center justify-center">
                      <Camera className="h-5 w-5 text-emerald-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Coverage Gaps</p>
                      <p className={cn(
                        "text-3xl font-bold tabular-nums mt-1",
                        (stats.gaps ?? 0) > 0 ? "text-amber-600" : "text-slate-400"
                      )}>{stats.gaps ?? 0}</p>
                    </div>
                    <div className={cn(
                      "h-11 w-11 rounded-xl flex items-center justify-center",
                      (stats.gaps ?? 0) > 0 ? "bg-amber-100" : "bg-slate-100"
                    )}>
                      <AlertTriangle className={cn(
                        "h-5 w-5",
                        (stats.gaps ?? 0) > 0 ? "text-amber-600" : "text-slate-400"
                      )} />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Photo Quality Avg</p>
                      <div className="flex items-baseline gap-1.5 mt-1">
                        <span className={cn(
                          "text-3xl font-bold tabular-nums",
                          (stats.avg_photo_quality ?? 0) >= 70 ? "text-emerald-600" :
                          (stats.avg_photo_quality ?? 0) >= 40 ? "text-blue-600" : "text-amber-600"
                        )}>
                          {stats.avg_photo_quality ?? 0}
                        </span>
                        <span className="text-sm text-muted-foreground">/100</span>
                      </div>
                    </div>
                    <div className="h-11 w-11 rounded-xl bg-violet-100 flex items-center justify-center">
                      <Eye className="h-5 w-5 text-violet-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* ------------------------------------------------------ */}
            {/*  Tabs                                                   */}
            {/* ------------------------------------------------------ */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="bg-white border shadow-sm">
                <TabsTrigger value="gaps" className="gap-1.5 data-[state=active]:bg-amber-50 data-[state=active]:text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Coverage Gaps
                  {gaps.length > 0 && (
                    <Badge className="ml-1 h-5 min-w-[20px] justify-center bg-amber-100 text-amber-700 hover:bg-amber-100 text-[10px] font-bold">{gaps.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="matched" className="gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Matched
                  {matches.length > 0 && (
                    <Badge className="ml-1 h-5 min-w-[20px] justify-center bg-emerald-100 text-emerald-700 hover:bg-emerald-100 text-[10px] font-bold">{matches.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="all" className="gap-1.5">
                  <Layers className="h-3.5 w-3.5" />
                  All Listings
                  {allListings.length > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 min-w-[20px] justify-center text-[10px] font-bold">{allListings.length}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              {/* ---- Coverage Gaps Tab ---- */}
              <TabsContent value="gaps" className="mt-5">
                {gaps.length === 0 ? (
                  <Card className="border-0 shadow-sm">
                    <CardContent className="py-16 text-center">
                      <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
                      <p className="font-semibold text-foreground">Full coverage</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Every Domain listing has a matching FlexMedia project
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {gaps.map((g, i) => (
                      <GapCard key={g.listing?.domain_listing_id || i} listing={g.listing || g} />
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* ---- Matched Tab ---- */}
              <TabsContent value="matched" className="mt-5">
                {matches.length === 0 ? (
                  <Card className="border-0 shadow-sm">
                    <CardContent className="py-16 text-center">
                      <Info className="h-12 w-12 text-slate-300 mx-auto mb-3" />
                      <p className="font-semibold text-foreground">No matched listings</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        No Domain listings have been matched to FlexMedia projects yet
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {matches.map((m, i) => (
                      <MatchedCard key={m.listing?.domain_listing_id || i} match={m} />
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* ---- All Listings Tab ---- */}
              <TabsContent value="all" className="mt-5">
                <Card className="border-0 shadow-sm overflow-hidden">
                  <AllListingsTable listings={allListings} matches={matches} />
                </Card>
              </TabsContent>
            </Tabs>

            {/* ------------------------------------------------------ */}
            {/*  Unmatched FlexMedia Projects                           */}
            {/* ------------------------------------------------------ */}
            {unmatchedProjects.length > 0 && (
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-slate-400" />
                    FlexMedia Projects Without Domain Listing
                    <Badge variant="secondary" className="ml-1 text-xs">{unmatchedProjects.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="divide-y divide-border">
                    {unmatchedProjects.map((p) => (
                      <div key={p.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">
                            {p.property_address || p.title}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {p.status && (
                              <Badge variant="outline" className="text-[10px] capitalize">
                                {p.status.replace(/_/g, " ")}
                              </Badge>
                            )}
                            {p.shoot_date && (
                              <span className="text-xs text-muted-foreground">
                                {new Date(p.shoot_date).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                              </span>
                            )}
                          </div>
                        </div>
                        <Link
                          to={createPageUrl(`ProjectDetails?id=${p.id}`)}
                          className="text-sm font-medium text-primary hover:text-primary/80 transition-colors shrink-0 ml-3"
                        >
                          View
                        </Link>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* No data / error fallback */}
        {!isLoading && !data && selectedAgent && (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center">
              <AlertTriangle className="h-12 w-12 text-amber-300 mx-auto mb-3" />
              <p className="font-semibold text-foreground">Unable to load monitor data</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                The Domain agent monitor did not return data for this agent.
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" /> Try Again
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

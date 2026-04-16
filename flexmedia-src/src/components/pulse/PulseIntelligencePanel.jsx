/**
 * PulseIntelligencePanel — Complete Intelligence Dossier
 * Shows EVERYTHING the pulse engine has found for a person or organisation.
 *
 * Props:
 *   entityType: 'agent' | 'agency'
 *   crmEntityId: UUID of the CRM agent/agency
 *   crmEntity: the full CRM entity record
 */
import React, { useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import PulseTimeline from "./PulseTimeline";
import {
  Rss, Star, MapPin, Building2, Phone, Mail, Globe, ExternalLink, Award,
  TrendingUp, Users, Home, Clock, Link2, AlertTriangle, CheckCircle2,
  DollarSign, Briefcase, Hash, Image, Zap, Facebook, Instagram, Linkedin,
  ChevronRight
} from "lucide-react";

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  return v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`;
}
function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); } catch { return "—"; }
}

const Src = ({ s }) => <span className={cn("text-[7px] font-bold uppercase px-1 py-0 rounded ml-1 inline-block leading-relaxed",
  s === "REA" ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400" :
  s === "Domain" ? "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400" :
  "bg-gray-100 text-gray-500")}>{s}</span>;

function mapPosition(jobTitle) {
  const jt = (jobTitle || "").toLowerCase();
  return (jt.includes("principal") || jt.includes("director") || jt.includes("managing") || jt.includes("licensee") || jt.includes("owner") || jt.includes("ceo") || jt.includes("partner")) ? "Partner"
    : (jt.includes("senior") || jt.includes("manager") || jt.includes("head of") || jt.includes("auctioneer")) ? "Senior" : "Junior";
}

export default function PulseIntelligencePanel({ entityType, crmEntityId, crmEntity }) {
  const { data: mappings = [] } = useEntityList("PulseCrmMapping", "-created_at");
  const { data: pulseAgents = [] } = useEntityList("PulseAgent", "-sales_as_lead", 5000);
  const { data: pulseAgencies = [] } = useEntityList("PulseAgency", "name");
  const { data: pulseListings = [] } = useEntityList("PulseListing", "-created_at", 5000);
  const { data: timeline = [] } = useEntityList("PulseTimeline", "-created_at", 2000);
  const { data: crmProjects = [] } = useEntityList("Project", "-shoot_date");

  // ── Find mapping ──
  const mapping = useMemo(() =>
    mappings.find(m => m.crm_entity_id === crmEntityId && m.entity_type === entityType),
    [mappings, crmEntityId, entityType]
  );

  // ── Find pulse data via ID chain ──
  const pulseData = useMemo(() => {
    const collection = entityType === "agent" ? pulseAgents : pulseAgencies;
    if (mapping?.pulse_entity_id) {
      const match = collection.find(a => a.id === mapping.pulse_entity_id);
      if (match) return match;
    }
    if (mapping?.rea_id) {
      const f = entityType === "agent" ? "rea_agent_id" : "rea_agency_id";
      const match = collection.find(a => a[f] === mapping.rea_id);
      if (match) return match;
    }
    if (mapping?.domain_id) {
      const f = entityType === "agent" ? "domain_agent_id" : "domain_agency_id";
      const match = collection.find(a => a[f] === mapping.domain_id);
      if (match) return match;
    }
    if (entityType === "agent") {
      if (crmEntity?.rea_agent_id) { const m = pulseAgents.find(a => a.rea_agent_id === crmEntity.rea_agent_id); if (m) return m; }
      if (crmEntity?.domain_agent_id) { const m = pulseAgents.find(a => a.domain_agent_id === crmEntity.domain_agent_id); if (m) return m; }
    } else {
      if (crmEntity?.rea_agency_id) { const m = pulseAgencies.find(a => a.rea_agency_id === crmEntity.rea_agency_id); if (m) return m; }
      if (crmEntity?.domain_agency_id) { const m = pulseAgencies.find(a => a.domain_agency_id === crmEntity.domain_agency_id); if (m) return m; }
    }
    return null;
  }, [entityType, mapping, pulseAgents, pulseAgencies, crmEntity]);

  // ── Filter timeline ──
  const entityTimeline = useMemo(() => {
    if (!crmEntityId) return [];
    return timeline.filter(t => {
      if (t.crm_entity_id === crmEntityId) return true;
      if (mapping?.rea_id && t.rea_id === mapping.rea_id) return true;
      if (mapping?.domain_id && t.domain_id === mapping.domain_id) return true;
      if (mapping?.pulse_entity_id && t.pulse_entity_id === mapping.pulse_entity_id) return true;
      if (crmEntity?.rea_agent_id && t.rea_id === crmEntity.rea_agent_id) return true;
      if (crmEntity?.rea_agency_id && t.rea_id === crmEntity.rea_agency_id) return true;
      return false;
    });
  }, [timeline, crmEntityId, mapping, crmEntity]);

  // ── Agent's listings (by ID first, then name) ──
  const entityListings = useMemo(() => {
    if (!pulseData) return [];
    if (entityType === "agent") {
      const reaId = pulseData.rea_agent_id;
      if (reaId) {
        const byId = pulseListings.filter(l => l.agent_rea_id === reaId);
        if (byId.length > 0) return byId;
      }
      const name = (pulseData.full_name || "").toLowerCase().trim();
      return pulseListings.filter(l => l.agent_name && l.agent_name.toLowerCase().trim() === name);
    } else {
      const reaId = pulseData.rea_agency_id;
      if (reaId) {
        const byId = pulseListings.filter(l => l.agency_rea_id === reaId);
        if (byId.length > 0) return byId;
      }
      const normName = (s) => (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      const name = normName(pulseData.name);
      return pulseListings.filter(l => normName(l.agency_name) === name);
    }
  }, [entityType, pulseData, pulseListings]);

  const forSaleListings = entityListings.filter(l => l.listing_type === "for_sale");
  const forRentListings = entityListings.filter(l => l.listing_type === "for_rent");
  const soldListings = entityListings.filter(l => l.listing_type === "sold");

  // CRM projects for this entity (our photography jobs)
  const entityProjects = useMemo(() => {
    if (entityType === "agent") {
      return crmProjects.filter(p => p.agent_id === crmEntityId || p.client_id === crmEntityId);
    } else {
      return crmProjects.filter(p => p.agency_id === crmEntityId);
    }
  }, [crmProjects, crmEntityId, entityType]);

  // Cross-reference: find pulse listings that match CRM projects by address
  const normAddr = (s) => (s || "").replace(/[,\s]+/g, " ").replace(/\b(nsw|vic|qld|sa|wa|tas|nt|act)\b/gi, "").replace(/\d{4}/, "").replace(/australia/gi, "").trim().toLowerCase();
  const projectAddresses = new Set(entityProjects.map(p => normAddr(p.property_address)));
  const crossLinked = entityListings.filter(l => projectAddresses.has(normAddr(l.address)));

  // ── Agency agents ──
  const agencyAgents = useMemo(() => {
    if (entityType !== "agency" || !pulseData) return [];
    if (pulseData.rea_agency_id) {
      const byId = pulseAgents.filter(a => a.agency_rea_id === pulseData.rea_agency_id);
      if (byId.length > 0) return byId.sort((a, b) => (b.sales_as_lead || 0) - (a.sales_as_lead || 0));
    }
    const normName = (s) => (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const name = normName(pulseData.name || crmEntity?.name);
    return pulseAgents.filter(a => normName(a.agency_name) === name).sort((a, b) => (b.sales_as_lead || 0) - (a.sales_as_lead || 0));
  }, [entityType, pulseData, crmEntity, pulseAgents]);

  // ── Parse sales breakdown ──
  const salesBreakdown = useMemo(() => {
    if (!pulseData?.sales_breakdown) return null;
    try { return typeof pulseData.sales_breakdown === "string" ? JSON.parse(pulseData.sales_breakdown) : pulseData.sales_breakdown; } catch { return null; }
  }, [pulseData]);

  const hasDual = pulseData && (pulseData.source || "").includes("+");

  // ── Empty state ──
  if (!pulseData && !mapping && entityTimeline.length === 0) {
    return (
      <div className="text-center py-12">
        <Rss className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No Industry Pulse data linked to this {entityType}.</p>
        <p className="text-[10px] text-muted-foreground/50 mt-1">Run a data sync in Industry Pulse to populate intelligence data.</p>
      </div>
    );
  }

  const a = pulseData; // shorthand

  return (
    <div className="space-y-4">
      {/* ═══ HEADER BAR ═══ */}
      <div className="flex items-center gap-2 flex-wrap text-xs px-1">
        {mapping ? (
          <Badge variant="outline" className={cn("text-[9px] gap-1", mapping.confidence === "confirmed" ? "text-green-600 border-green-200" : "text-amber-600 border-amber-200")}>
            {mapping.confidence === "confirmed" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
            {mapping.confidence === "confirmed" ? "Confirmed" : "Suggested"} — {mapping.match_type}
          </Badge>
        ) : <Badge variant="outline" className="text-[9px] text-muted-foreground">Not mapped</Badge>}
        {a?.rea_agent_id && <Badge variant="outline" className="text-[8px] bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">REA {a.rea_agent_id}</Badge>}
        {a?.domain_agent_id && <Badge variant="outline" className="text-[8px] bg-violet-50 dark:bg-violet-950/20 border-violet-200 text-violet-600">Domain {a.domain_agent_id}</Badge>}
        {a?.rea_agency_id && <Badge variant="outline" className="text-[8px] bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">REA {a.rea_agency_id}</Badge>}
        {a?.domain_agency_id && <Badge variant="outline" className="text-[8px] bg-violet-50 dark:bg-violet-950/20 border-violet-200 text-violet-600">Domain {a.domain_agency_id}</Badge>}
        {a?.data_integrity_score > 0 && <Badge variant="outline" className="text-[8px]">Quality: {a.data_integrity_score}%</Badge>}
        {hasDual && <Badge variant="outline" className="text-[8px] text-green-600 border-green-200">Dual-verified</Badge>}
        {a?.last_synced_at && <span className="text-[9px] text-muted-foreground ml-auto">Synced: {fmtDate(a.last_synced_at)}</span>}
      </div>

      {/* ═══ AGENT DOSSIER ═══ */}
      {entityType === "agent" && a && (<>
        {/* Profile Card */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              {a.profile_image && <img src={a.profile_image} alt="" className="h-16 w-16 rounded-full object-cover shrink-0 border" />}
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-base">{a.full_name}</h3>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {a.job_title && <span className="text-xs text-muted-foreground">{a.job_title}</span>}
                  <Badge variant="outline" className={cn("text-[8px]",
                    mapPosition(a.job_title) === "Partner" ? "text-purple-600 border-purple-200" :
                    mapPosition(a.job_title) === "Senior" ? "text-blue-600 border-blue-200" : "text-muted-foreground"
                  )}>{mapPosition(a.job_title)}</Badge>
                  {a.years_experience && <span className="text-[10px] text-muted-foreground">{a.years_experience} yrs exp</span>}
                </div>
                {a.agency_name && (
                  <div className="flex items-center gap-1.5 mt-1 text-xs">
                    <Building2 className="h-3 w-3 text-muted-foreground" />
                    <span className="font-medium">{a.agency_name}</span>
                    {a.agency_suburb && <span className="text-muted-foreground">· {a.agency_suburb}</span>}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {a.mobile && <div className="flex items-center gap-1 text-xs"><Phone className="h-3 w-3 text-muted-foreground" /><a href={`tel:${a.mobile}`} className="text-primary hover:underline">{a.mobile}</a></div>}
                  {a.email && <div className="flex items-center gap-1 text-xs"><Mail className="h-3 w-3 text-muted-foreground" /><a href={`mailto:${a.email}`} className="text-primary hover:underline">{a.email}</a></div>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Performance + Reviews */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase">Performance</h3>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{a.sales_as_lead || a.total_sold_12m || 0}</p>
                <p className="text-[9px] text-muted-foreground">Sales (Lead)</p>
                <Src s={a.sales_as_lead ? "REA" : "Domain"} />
              </div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{fmtPrice(a.avg_sold_price)}</p>
                <p className="text-[9px] text-muted-foreground">Median Sold</p>
                <Src s={a.rea_median_sold_price ? "REA" : "Domain"} />
              </div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{a.avg_days_on_market || "—"}</p>
                <p className="text-[9px] text-muted-foreground">Avg DOM</p>
                <Src s={a.rea_median_dom ? "REA" : "Domain"} />
              </div>
            </div>

            {/* Dual source comparison */}
            {hasDual && (a.rea_median_sold_price || a.domain_avg_sold_price) && (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-[10px]">
                  <thead className="bg-muted/30"><tr><th className="px-2 py-1 text-left text-muted-foreground">Metric</th><th className="px-2 py-1 text-center text-red-600">REA</th><th className="px-2 py-1 text-center text-violet-600">Domain</th></tr></thead>
                  <tbody>
                    {(a.rea_median_sold_price || a.domain_avg_sold_price) && <tr className="border-t"><td className="px-2 py-1">Sold Price</td><td className="px-2 py-1 text-center tabular-nums">{fmtPrice(a.rea_median_sold_price)}</td><td className="px-2 py-1 text-center tabular-nums">{fmtPrice(a.domain_avg_sold_price)}</td></tr>}
                    {(a.rea_median_dom || a.domain_avg_dom) && <tr className="border-t"><td className="px-2 py-1">Days on Market</td><td className="px-2 py-1 text-center tabular-nums">{a.rea_median_dom || "—"}</td><td className="px-2 py-1 text-center tabular-nums">{a.domain_avg_dom || "—"}</td></tr>}
                    {(a.rea_rating || a.domain_rating) && <tr className="border-t"><td className="px-2 py-1">Rating</td><td className="px-2 py-1 text-center tabular-nums">{a.rea_rating ? `${a.rea_rating} (${a.rea_review_count || 0})` : "—"}</td><td className="px-2 py-1 text-center tabular-nums">{a.domain_rating ? `${a.domain_rating} (${a.domain_review_count || 0})` : "—"}</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {/* Reviews */}
            {(a.reviews_count > 0 || a.rea_rating > 0) && (
              <div className="flex items-center gap-3">
                <Star className="h-5 w-5 fill-amber-400 text-amber-400" />
                <span className="text-xl font-bold">{Number(a.reviews_avg || a.rea_rating).toFixed(1)}</span>
                <span className="text-xs text-muted-foreground">{a.reviews_count || 0} reviews</span>
                {a.rea_rating > 0 && <span className="text-[10px]"><Src s="REA" />{a.rea_rating} ({a.rea_review_count || 0})</span>}
                {a.domain_rating > 0 && <span className="text-[10px]"><Src s="Domain" />{a.domain_rating} ({a.domain_review_count || 0})</span>}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Our Projects (CRM) */}
        {entityProjects.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Briefcase className="h-3.5 w-3.5 text-primary" />Our Projects ({entityProjects.length})</h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {entityProjects.slice(0, 15).map(p => {
                  const isCrossLinked = crossLinked.some(l => normAddr(l.address) === normAddr(p.property_address));
                  return (
                    <div key={p.id} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/20">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{p.title || p.property_address}</p>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Badge variant="outline" className={cn("text-[7px] py-0",
                            p.status === "delivered" ? "text-green-600 border-green-200" :
                            p.status === "scheduled" ? "text-blue-600 border-blue-200" :
                            "text-muted-foreground")}>{p.status}</Badge>
                          {p.shoot_date && <span>{fmtDate(p.shoot_date)}</span>}
                        </div>
                      </div>
                      {isCrossLinked && <Badge className="text-[7px] bg-indigo-100 text-indigo-700 border-0 shrink-0 ml-2">Pulse Match</Badge>}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* For Sale Listings (from pulse — properties currently on market) */}
        {forSaleListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Home className="h-3.5 w-3.5" />For Sale ({forSaleListings.length})</h3>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {forSaleListings.slice(0, 20).map(l => (
                  <a key={l.id} href={l.source_url || l.domain_listing_url || "#"} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors">
                    {l.image_url && <img src={l.image_url} alt="" className="h-10 w-14 object-cover rounded shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{l.address || l.suburb || "—"}</p>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        {l.suburb && <span>{l.suburb}</span>}
                        {l.bedrooms && <span>{l.bedrooms} bed</span>}
                        {l.asking_price > 0 && <span className="font-medium text-foreground">{fmtPrice(l.asking_price)}</span>}
                        {l.first_seen_at && <span className="text-[9px]">Detected {fmtDate(l.first_seen_at)}</span>}
                      </div>
                    </div>
                    <ExternalLink className="h-3 w-3 text-primary shrink-0" />
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* For Rent Listings */}
        {forRentListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Home className="h-3.5 w-3.5" />For Rent ({forRentListings.length})</h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {forRentListings.slice(0, 15).map(l => (
                  <a key={l.id} href={l.source_url || l.domain_listing_url || "#"} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{l.address || l.suburb}</p>
                      <span className="text-muted-foreground">{l.suburb}{l.asking_price > 0 ? ` · ${fmtPrice(l.asking_price)}/wk` : ""}</span>
                    </div>
                    <Badge variant="outline" className="text-[7px] py-0 text-purple-600 border-purple-200 shrink-0">Rent</Badge>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Sold Properties (from pulse sold listings) */}
        {soldListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><DollarSign className="h-3.5 w-3.5" />Sold Properties ({soldListings.length})</h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {soldListings.slice(0, 15).map(l => (
                  <a key={l.id} href={l.source_url || "#"} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-between text-xs p-1.5 rounded hover:bg-muted/30">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{l.address || l.suburb}</p>
                      <span className="text-muted-foreground">{l.suburb}{l.sold_price > 0 ? ` · ${fmtPrice(l.sold_price)}` : ""}{l.sold_date ? ` · Sold ${fmtDate(l.sold_date)}` : ""}</span>
                    </div>
                    <Badge className="text-[7px] bg-emerald-100 text-emerald-700 border-0 shrink-0">Sold</Badge>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Sales Breakdown */}
        {salesBreakdown && Object.keys(salesBreakdown).length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1">Sales by Property Type<Src s="REA" /></h3>
              <div className="space-y-1">
                {Object.entries(salesBreakdown).map(([type, data]) => (
                  <div key={type} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2.5 py-1.5">
                    <span className="capitalize font-medium">{type}</span>
                    <span className="text-muted-foreground tabular-nums">{data.count} sold · {fmtPrice(data.medianSoldPrice)} median · {data.medianDaysOnSite}d DOM</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Awards */}
        {a.awards && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Award className="h-3.5 w-3.5" />Awards<Src s="REA" /></h3>
              <div className="text-xs text-muted-foreground whitespace-pre-line bg-amber-50/50 dark:bg-amber-950/10 rounded p-2.5 border border-amber-200/30">{a.awards}</div>
            </CardContent>
          </Card>
        )}

        {/* Speciality + Social + Links */}
        <Card>
          <CardContent className="p-4 space-y-3">
            {a.speciality_suburbs && (
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1 flex items-center gap-1"><MapPin className="h-3 w-3" />Speciality Areas<Src s="REA" /></h3>
                <p className="text-xs text-muted-foreground">{a.speciality_suburbs}</p>
              </div>
            )}
            {a.community_involvement && (
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Community<Src s="REA" /></h3>
                <p className="text-xs text-muted-foreground whitespace-pre-line">{a.community_involvement}</p>
              </div>
            )}
            {(a.social_facebook || a.social_instagram || a.social_linkedin) && (
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Social</h3>
                <div className="flex gap-3">
                  {a.social_facebook && <a href={a.social_facebook} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Facebook</a>}
                  {a.social_instagram && <a href={`https://instagram.com/${a.social_instagram.replace("@","")}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Instagram</a>}
                  {a.social_linkedin && <a href={a.social_linkedin} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">LinkedIn</a>}
                </div>
              </div>
            )}
            <div className="pt-2 border-t">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Platform Profiles</h3>
              <div className="flex gap-3">
                {a.rea_profile_url && <a href={a.rea_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />realestate.com.au<Src s="REA" /></a>}
                {a.domain_profile_url && <a href={a.domain_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />domain.com.au<Src s="Domain" /></a>}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Enrichment Metadata */}
        <div className="text-[10px] text-muted-foreground px-1 space-y-0.5">
          <p>Source: {a.source || "—"} · First seen: {fmtDate(a.first_seen_at)} · Last synced: {fmtDate(a.last_synced_at)}</p>
          {a.rea_agent_id && <p><Src s="REA" /> Agent ID: {a.rea_agent_id}</p>}
          {a.domain_agent_id && <p><Src s="Domain" /> Agent ID: {a.domain_agent_id}</p>}
        </div>
      </>)}

      {/* ═══ AGENCY DOSSIER ═══ */}
      {entityType === "agency" && a && (<>
        {/* Agency Profile Card */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              {a.logo_url && <img src={a.logo_url} alt="" className="h-12 w-20 object-contain shrink-0 rounded border bg-white" />}
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-base">{a.name}</h3>
                {(a.suburb || a.address) && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                    <MapPin className="h-3 w-3" />{a.address || a.suburb}{a.state ? `, ${a.state}` : ""}{a.postcode ? ` ${a.postcode}` : ""}
                  </div>
                )}
                {a.profile_tier && <Badge variant="outline" className="text-[8px] mt-1 capitalize">{a.profile_tier}</Badge>}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {a.phone && <div className="flex items-center gap-1 text-xs"><Phone className="h-3 w-3 text-muted-foreground" /><a href={`tel:${a.phone}`} className="text-primary hover:underline">{a.phone}</a></div>}
                  {a.email && <div className="flex items-center gap-1 text-xs"><Mail className="h-3 w-3 text-muted-foreground" /><a href={`mailto:${a.email}`} className="text-primary hover:underline">{a.email}</a></div>}
                  {a.website && <div className="flex items-center gap-1 text-xs"><Globe className="h-3 w-3 text-muted-foreground" /><a href={a.website.startsWith("http") ? a.website : `https://${a.website}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate max-w-[200px]">{a.website}</a></div>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Key Metrics */}
        <Card>
          <CardContent className="p-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Key Metrics</h3>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{agencyAgents.length || a.agent_count || 0}</p><p className="text-[9px] text-muted-foreground">Agents</p></div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{a.active_listings || 0}</p><p className="text-[9px] text-muted-foreground">Active Listings</p></div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{fmtPrice(a.avg_listing_price || a.avg_sold_price)}</p><p className="text-[9px] text-muted-foreground">Avg Price</p></div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{a.total_sold_12m || a.total_sold_and_auctioned || 0}</p><p className="text-[9px] text-muted-foreground">Sold (12m)</p></div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{a.avg_agent_rating ? Number(a.avg_agent_rating).toFixed(1) : "—"}</p><p className="text-[9px] text-muted-foreground">Avg Rating</p></div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{a.avg_days_on_market || "—"}</p><p className="text-[9px] text-muted-foreground">Avg DOM</p></div>
            </div>
          </CardContent>
        </Card>

        {/* Agent Roster */}
        {agencyAgents.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Users className="h-3.5 w-3.5" />Agent Roster ({agencyAgents.length})</h3>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Agent</th>
                      <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Position</th>
                      <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Sold</th>
                      <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Rating</th>
                      <th className="px-2 py-1.5 w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {agencyAgents.slice(0, 30).map(ag => (
                      <tr key={ag.id} className="border-t hover:bg-muted/20">
                        <td className="px-2 py-1.5">
                          <p className="font-medium">{ag.full_name}</p>
                          {ag.job_title && <p className="text-[9px] text-muted-foreground">{ag.job_title}</p>}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge variant="outline" className={cn("text-[8px]",
                            mapPosition(ag.job_title) === "Partner" ? "text-purple-600 border-purple-200" :
                            mapPosition(ag.job_title) === "Senior" ? "text-blue-600 border-blue-200" : "text-muted-foreground"
                          )}>{mapPosition(ag.job_title)}</Badge>
                        </td>
                        <td className="px-2 py-1.5 tabular-nums">{ag.sales_as_lead || 0}</td>
                        <td className="px-2 py-1.5">
                          {(ag.reviews_avg || ag.rea_rating) > 0 ? (
                            <span className="flex items-center gap-0.5"><Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />{Number(ag.reviews_avg || ag.rea_rating).toFixed(1)}</span>
                          ) : "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          {ag.is_in_crm && <Badge className="text-[7px] bg-green-100 text-green-700 border-0 px-1 py-0">CRM</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Our Projects (CRM) */}
        {entityProjects.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Briefcase className="h-3.5 w-3.5 text-primary" />Our Projects ({entityProjects.length})</h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {entityProjects.slice(0, 15).map(p => (
                  <div key={p.id} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/20">
                    <div className="min-w-0"><p className="font-medium truncate">{p.title || p.property_address}</p>
                      <Badge variant="outline" className="text-[7px] py-0">{p.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Agency For Sale Listings */}
        {forSaleListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Home className="h-3.5 w-3.5" />For Sale ({forSaleListings.length})</h3>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {forSaleListings.slice(0, 20).map(l => (
                  <a key={l.id} href={l.source_url || l.domain_listing_url || "#"} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors">
                    {l.image_url && <img src={l.image_url} alt="" className="h-10 w-14 object-cover rounded shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{l.address || "—"}</p>
                      <span className="text-muted-foreground">{l.suburb}{l.asking_price > 0 ? ` · ${fmtPrice(l.asking_price)}` : ""}{l.agent_name ? ` · ${l.agent_name}` : ""}</span>
                    </div>
                    <ExternalLink className="h-3 w-3 text-primary shrink-0" />
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Agency Rental Listings */}
        {forRentListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><Home className="h-3.5 w-3.5" />For Rent ({forRentListings.length})</h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {forRentListings.slice(0, 15).map(l => (
                  <a key={l.id} href={l.source_url || "#"} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{l.address || l.suburb}</p>
                      <span className="text-muted-foreground">{l.suburb}{l.asking_price > 0 ? ` · ${fmtPrice(l.asking_price)}/wk` : ""}{l.agent_name ? ` · ${l.agent_name}` : ""}</span>
                    </div>
                    <Badge variant="outline" className="text-[7px] py-0 text-purple-600 shrink-0">Rent</Badge>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Active Suburbs */}
        {(() => {
          const suburbs = (() => { try { return typeof a.suburbs_active === "string" ? JSON.parse(a.suburbs_active) : (a.suburbs_active || []); } catch { return []; } })();
          return suburbs.length > 0 ? (
            <Card>
              <CardContent className="p-4">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />Active Suburbs</h3>
                <div className="flex flex-wrap gap-1">{suburbs.map(s => <Badge key={s} variant="outline" className="text-[9px] px-1.5 py-0">{s}</Badge>)}</div>
              </CardContent>
            </Card>
          ) : null;
        })()}

        {/* Profile Links */}
        {(a.rea_profile_url || a.domain_profile_url) && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Platform Profiles</h3>
              <div className="flex gap-3">
                {a.rea_profile_url && <a href={a.rea_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />realestate.com.au<Src s="REA" /></a>}
                {a.domain_profile_url && <a href={a.domain_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />domain.com.au<Src s="Domain" /></a>}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Enrichment Metadata */}
        <div className="text-[10px] text-muted-foreground px-1 space-y-0.5">
          <p>Source: {a.source || "—"} · First seen: {fmtDate(a.first_seen_at)} · Last synced: {fmtDate(a.last_synced_at)}</p>
          {a.rea_agency_id && <p><Src s="REA" /> Agency ID: {a.rea_agency_id}</p>}
          {a.domain_agency_id && <p><Src s="Domain" /> Agency ID: {a.domain_agency_id}</p>}
        </div>
      </>)}

      {/* ═══ TIMELINE (both entity types) ═══ */}
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Clock className="h-4 w-4 text-primary" />Intelligence Timeline</h3>
          <PulseTimeline
            entries={entityTimeline}
            maxHeight="max-h-[500px]"
            emptyMessage={`No timeline events for this ${entityType} yet. Events will appear after data syncs detect changes.`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

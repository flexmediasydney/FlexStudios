/**
 * PulseIntelligencePanel — Reusable intelligence view for People and Organisation detail pages.
 * Shows pulse profile summary, market data, and timeline.
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
  TrendingUp, Users, Home, Clock, Link2, AlertTriangle, CheckCircle2
} from "lucide-react";

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  return v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`;
}

export default function PulseIntelligencePanel({ entityType, crmEntityId, crmEntity }) {
  const { data: mappings = [] } = useEntityList("PulseCrmMapping", "-created_at");
  const { data: pulseAgents = [] } = useEntityList("PulseAgent", "-sales_as_lead", 5000);
  const { data: pulseAgencies = [] } = useEntityList("PulseAgency", "name");
  const { data: timeline = [] } = useEntityList("PulseTimeline", "-created_at", 500);

  // Find mapping for this CRM entity
  const mapping = useMemo(() =>
    mappings.find(m => m.crm_entity_id === crmEntityId && m.entity_type === entityType),
    [mappings, crmEntityId, entityType]
  );

  // Find pulse data via 6-ID platform matching, then mapping, then name fallback
  const pulseData = useMemo(() => {
    if (entityType === "agent") {
      // Priority 1: Direct ID match from CRM record's platform IDs
      if (crmEntity?.rea_agent_id) {
        const match = pulseAgents.find(a => a.rea_agent_id === crmEntity.rea_agent_id);
        if (match) return match;
      }
      if (crmEntity?.domain_agent_id) {
        const match = pulseAgents.find(a => a.domain_agent_id === crmEntity.domain_agent_id);
        if (match) return match;
      }
      // Priority 2: Mapping table
      if (mapping?.rea_id) {
        const match = pulseAgents.find(a => a.rea_agent_id === mapping.rea_id);
        if (match) return match;
      }
      if (mapping?.domain_id) {
        const match = pulseAgents.find(a => a.domain_agent_id === mapping.domain_id);
        if (match) return match;
      }
      // Priority 3: Name fallback
      const name = (crmEntity?.name || "").toLowerCase().trim();
      return pulseAgents.find(a => (a.full_name || "").toLowerCase().trim() === name);
    } else {
      // Agency matching
      // Priority 1: Direct ID match
      if (crmEntity?.rea_agency_id) {
        const match = pulseAgencies.find(a => a.rea_agency_id === crmEntity.rea_agency_id);
        if (match) return match;
      }
      if (crmEntity?.domain_agency_id) {
        const match = pulseAgencies.find(a => a.domain_agency_id === crmEntity.domain_agency_id);
        if (match) return match;
      }
      // Priority 2: Mapping table
      if (mapping?.rea_id) {
        const match = pulseAgencies.find(a => a.rea_agency_id === mapping.rea_id);
        if (match) return match;
      }
      if (mapping?.domain_id) {
        const match = pulseAgencies.find(a => a.domain_agency_id === mapping.domain_id);
        if (match) return match;
      }
      // Priority 3: Name fallback (normalize dashes for matching)
      const normName = (s) => (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      const name = normName(crmEntity?.name);
      return pulseAgencies.find(a => {
        const n = normName(a.name);
        return n === name || n.includes(name) || name.includes(n);
      });
    }
  }, [entityType, mapping, pulseAgents, pulseAgencies, crmEntity]);

  // Filter timeline entries for this entity
  const entityTimeline = useMemo(() => {
    if (!crmEntityId) return [];
    return timeline.filter(t => {
      if (t.crm_entity_id === crmEntityId) return true;
      if (mapping?.rea_id && t.rea_id === mapping.rea_id) return true;
      if (mapping?.domain_id && t.domain_id === mapping.domain_id) return true;
      if (mapping?.pulse_entity_id && t.pulse_entity_id === mapping.pulse_entity_id) return true;
      // Also match by CRM entity's own platform IDs
      if (crmEntity?.rea_agent_id && t.rea_id === crmEntity.rea_agent_id) return true;
      if (crmEntity?.rea_agency_id && t.rea_id === crmEntity.rea_agency_id) return true;
      return false;
    });
  }, [timeline, crmEntityId, mapping, crmEntity]);

  // For agencies: find all agents at this agency (normalize dashes)
  const agencyAgents = useMemo(() => {
    if (entityType !== "agency" || !crmEntity?.name) return [];
    const normName = (s) => (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const agencyName = normName(crmEntity.name);
    return pulseAgents.filter(a => {
      const an = normName(a.agency_name);
      return an === agencyName || an.includes(agencyName) || agencyName.includes(an);
    }).sort((a, b) => (b.sales_as_lead || 0) - (a.sales_as_lead || 0));
  }, [entityType, crmEntity, pulseAgents]);

  if (!pulseData && !mapping && entityTimeline.length === 0) {
    return (
      <div className="text-center py-12">
        <Rss className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No Industry Pulse data linked to this {entityType}.</p>
        <p className="text-[10px] text-muted-foreground/50 mt-1">Run a data sync in Industry Pulse to populate intelligence data.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* Mapping status */}
      <div className="flex items-center gap-2 text-xs">
        {mapping ? (
          <>
            <Link2 className="h-3.5 w-3.5 text-green-500" />
            <span className="text-green-600 dark:text-green-400 font-medium">
              Mapped to Pulse — {mapping.confidence === "confirmed" ? "Confirmed" : "Suggested"} via {mapping.match_type}
            </span>
            {mapping.rea_id && <Badge variant="outline" className="text-[9px] px-1 py-0">REA: {mapping.rea_id}</Badge>}
          </>
        ) : pulseData ? (
          <>
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-amber-600 dark:text-amber-400">Matched by name — not formally mapped</span>
          </>
        ) : (
          <>
            <Rss className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">No pulse data found</span>
          </>
        )}
      </div>

      {/* Agent Intelligence Summary */}
      {entityType === "agent" && pulseData && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2"><Rss className="h-4 w-4 text-primary" />Market Intelligence</h3>
              {pulseData.last_synced_at && <span className="text-[9px] text-muted-foreground">Synced: {new Date(pulseData.last_synced_at).toLocaleDateString("en-AU")}</span>}
            </div>

            {/* Performance stats */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{pulseData.sales_as_lead || pulseData.total_sold_12m || 0}</p>
                <p className="text-[9px] text-muted-foreground">Sales (12m)</p>
              </div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{fmtPrice(pulseData.avg_sold_price)}</p>
                <p className="text-[9px] text-muted-foreground">Median Sold</p>
              </div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{pulseData.avg_days_on_market || "—"}</p>
                <p className="text-[9px] text-muted-foreground">Avg DOM</p>
              </div>
            </div>

            {/* Reviews */}
            {(pulseData.reviews_avg || pulseData.rea_rating) > 0 && (
              <div className="flex items-center gap-2">
                <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                <span className="font-bold">{Number(pulseData.reviews_avg || pulseData.rea_rating).toFixed(1)}</span>
                <span className="text-xs text-muted-foreground">({pulseData.reviews_count || 0} reviews)</span>
              </div>
            )}

            {/* Sales breakdown */}
            {pulseData.sales_breakdown && (() => {
              const bd = typeof pulseData.sales_breakdown === "string" ? JSON.parse(pulseData.sales_breakdown) : pulseData.sales_breakdown;
              if (!bd || Object.keys(bd).length === 0) return null;
              return (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Sales by Type</p>
                  {Object.entries(bd).map(([type, data]) => (
                    <div key={type} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2 py-1">
                      <span className="capitalize font-medium">{type}</span>
                      <span className="text-muted-foreground tabular-nums">{data.count} · {fmtPrice(data.medianSoldPrice)} · {data.medianDaysOnSite}d</span>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Awards */}
            {pulseData.awards && (
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1 mb-1"><Award className="h-3 w-3" />Awards</p>
                <div className="text-xs text-muted-foreground whitespace-pre-line bg-amber-50/50 dark:bg-amber-950/10 rounded p-2 border border-amber-200/30 dark:border-amber-800/20 line-clamp-5">{pulseData.awards}</div>
              </div>
            )}

            {/* Speciality + Social */}
            {pulseData.speciality_suburbs && (
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">Speciality Areas</p>
                <p className="text-xs text-muted-foreground">{pulseData.speciality_suburbs}</p>
              </div>
            )}

            {/* Profile links */}
            <div className="flex gap-3 pt-1 border-t">
              {pulseData.rea_profile_url && <a href={pulseData.rea_profile_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />REA Profile</a>}
              {pulseData.domain_profile_url && <a href={pulseData.domain_profile_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />Domain Profile</a>}
              {pulseData.social_facebook && <a href={pulseData.social_facebook} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline">Facebook</a>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agency Intelligence Summary */}
      {entityType === "agency" && pulseData && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2"><Building2 className="h-4 w-4 text-primary" />Agency Intelligence</h3>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{pulseData.agent_count || 0}</p>
                <p className="text-[9px] text-muted-foreground">Agents</p>
              </div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{pulseData.active_listings || 0}</p>
                <p className="text-[9px] text-muted-foreground">Listings</p>
              </div>
              <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold">{fmtPrice(pulseData.avg_listing_price)}</p>
                <p className="text-[9px] text-muted-foreground">Avg Price</p>
              </div>
            </div>
            {pulseData.email && <div className="flex items-center gap-2 text-xs"><Mail className="h-3 w-3 text-muted-foreground" />{pulseData.email}</div>}
            {pulseData.website && <div className="flex items-center gap-2 text-xs"><Globe className="h-3 w-3 text-muted-foreground" /><a href={pulseData.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{pulseData.website}</a></div>}
          </CardContent>
        </Card>
      )}

      {/* Agent roster for agencies */}
      {entityType === "agency" && agencyAgents.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"><Users className="h-4 w-4 text-primary" />Agent Roster ({agencyAgents.length})</h3>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {agencyAgents.map(a => (
                <div key={a.id} className="flex items-center justify-between text-xs p-1.5 rounded hover:bg-muted/30">
                  <div>
                    <p className="font-medium">{a.full_name}</p>
                    {a.job_title && <p className="text-[10px] text-muted-foreground">{a.job_title}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {a.sales_as_lead > 0 && <span className="tabular-nums text-muted-foreground">{a.sales_as_lead} sales</span>}
                    {(a.reviews_avg || a.rea_rating) > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                        {Number(a.reviews_avg || a.rea_rating).toFixed(1)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Clock className="h-4 w-4 text-primary" />Intelligence Timeline</h3>
          <PulseTimeline
            entries={entityTimeline}
            maxHeight="max-h-[400px]"
            emptyMessage={`No timeline events for this ${entityType} yet. Events will appear after data syncs detect changes.`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

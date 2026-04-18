/**
 * PulseIntelligencePanel — REA-only Intelligence Dossier
 * Comprehensive view of everything the pulse engine knows about an agent or agency.
 *
 * Data sources: websift (agent profiles + stats), azzouzana (listings with agent emails/photos)
 * Single link ID: rea_agent_id connects agents -> listings -> agencies.
 *
 * Props:
 *   entityType: 'agent' | 'agency'
 *   entityId / crmEntityId: UUID of the CRM record
 *   entityName: CRM record display name (informational only)
 *   crmEntity: full CRM entity record (optional, used for rea_agent_id fallback)
 */
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import PulseTimeline from "@/components/pulse/PulseTimeline";
import { Star, MapPin, Building2, Phone, Mail, Globe, ExternalLink, Award,
  TrendingUp, Users, Home, Clock, AlertTriangle, CheckCircle2, DollarSign,
  Briefcase, Hash, Facebook, Instagram, Linkedin, ChevronDown, Shield,
  BarChart3, User, Loader2, BookOpen, Database, History
} from "lucide-react";
import { Button } from "@/components/ui/button";
import EntitySyncHistoryDialog from "@/components/pulse/EntitySyncHistoryDialog";
import {
  displayPrice as sharedDisplayPrice,
  LISTING_TYPE_LABEL,
  listingTypeBadgeClasses,
} from "@/components/pulse/utils/listingHelpers";

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function fmtPrice(v) {
  if (!v || v <= 0) return "\u2014";
  return v >= 1_000_000
    ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
      ? `$${Math.round(v / 1_000)}K`
      : `$${v}`;
}

function fmtDate(d) {
  if (!d) return "\u2014";
  try {
    return new Date(d).toLocaleDateString("en-AU", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return "\u2014"; }
}

function mapPosition(jobTitle) {
  const jt = (jobTitle || "").toLowerCase();
  if (
    jt.includes("principal") || jt.includes("director") || jt.includes("managing") ||
    jt.includes("licensee") || jt.includes("owner") || jt.includes("ceo") || jt.includes("partner")
  ) return "Partner";
  if (
    jt.includes("senior") || jt.includes("manager") || jt.includes("head of") || jt.includes("auctioneer")
  ) return "Senior";
  return jt.includes("associate") ? "Associate" : "Junior";
}

function positionColor(pos) {
  if (pos === "Partner") return "text-purple-600 border-purple-200";
  if (pos === "Senior") return "text-blue-600 border-blue-200";
  if (pos === "Associate") return "text-teal-600 border-teal-200";
  return "text-muted-foreground";
}

function integrityColor(score) {
  if (score > 70) return { text: "text-green-600", bg: "bg-green-500", border: "border-green-200", badge: "bg-green-50 dark:bg-green-950/20" };
  if (score >= 50) return { text: "text-amber-600", bg: "bg-amber-500", border: "border-amber-200", badge: "bg-amber-50 dark:bg-amber-950/20" };
  return { text: "text-red-600", bg: "bg-red-500", border: "border-red-200", badge: "bg-red-50 dark:bg-red-950/20" };
}

const normAddr = (s) =>
  (s || "").replace(/[,\s]+/g, " ").replace(/\b(nsw|vic|qld|sa|wa|tas|nt|act)\b/gi, "")
    .replace(/\d{4}/, "").replace(/australia/gi, "").trim().toLowerCase();

const normName = (s) =>
  (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

const parseJSON = (val) => {
  if (!val) return null;
  try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return null; }
};

const parseArray = (val) => {
  const parsed = parseJSON(val);
  return Array.isArray(parsed) ? parsed : [];
};

const REABadge = () => (
  <span className="text-[7px] font-bold uppercase px-1 py-0 rounded ml-1 inline-block leading-relaxed bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
    REA
  </span>
);

/* ── Section header ──────────────────────────────────────────────────────────── */

const SectionHeader = ({ icon: Icon, children, count }) => (
  <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 flex items-center gap-1.5">
    {Icon && <Icon className="h-3.5 w-3.5" />}
    {children}
    {count != null && count > 0 && (
      <Badge variant="outline" className="text-[8px] py-0 px-1 ml-1 tabular-nums">{count}</Badge>
    )}
  </h3>
);

/* ── Stat box ────────────────────────────────────────────────────────────────── */

const StatBox = ({ value, label }) => (
  <div className="bg-muted/40 rounded-lg p-2.5 text-center">
    <p className="text-lg font-bold">{value}</p>
    <p className="text-[9px] text-muted-foreground">{label}</p>
  </div>
);

/* ── Listing row (shared for sale/rent/sold) ─────────────────────────────────── */

const ListingRow = ({ l, showSoldInfo }) => {
  // Canonical price label (handles sold/rent/under_contract + /wk via suffix).
  const priceLabel = sharedDisplayPrice(l).label;
  const hasPrice = priceLabel && priceLabel !== "—" && priceLabel !== "\u2014";

  return (
    <a
      href={l.source_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors"
    >
      {l.image_url && (
        <img src={l.image_url} alt="" className="h-10 w-14 object-cover rounded shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{l.address || l.suburb || "\u2014"}</p>
        <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
          {l.suburb && <span>{l.suburb}</span>}
          {showSoldInfo ? (
            <>
              {hasPrice && <span className="font-medium text-foreground">{priceLabel}</span>}
              {l.sold_date && <span className="text-[9px]">Sold {fmtDate(l.sold_date)}</span>}
            </>
          ) : (
            <>
              {l.previous_asking_price && (
                <span className="text-muted-foreground line-through text-[10px] mr-1">
                  {fmtPrice(l.previous_asking_price)}
                </span>
              )}
              {hasPrice && <span className="font-medium text-foreground">{priceLabel}</span>}
              {l.bedrooms && <span>{l.bedrooms}bed</span>}
              {l.bathrooms && <span>{l.bathrooms}bath</span>}
              {l.first_seen_at && <span className="text-[9px]">Listed {fmtDate(l.first_seen_at)}</span>}
            </>
          )}
        </div>
      </div>
      {l.listing_type === "for_rent" && (
        <Badge variant="outline" className="text-[7px] py-0 text-purple-600 border-purple-200 shrink-0">Rent</Badge>
      )}
      {l.listing_type === "sold" && (
        <Badge className="text-[7px] bg-emerald-100 text-emerald-700 border-0 shrink-0">Sold</Badge>
      )}
      {l.listing_type === "under_contract" && (() => {
        // under_contract was missing from the badge set entirely — the listing
        // would render with NO badge. Use shared amber classes for consistency.
        const c = listingTypeBadgeClasses("under_contract");
        return (
          <Badge
            variant="outline"
            className={cn("text-[7px] py-0 shrink-0", c.text, c.border)}
          >
            {LISTING_TYPE_LABEL.under_contract}
          </Badge>
        );
      })()}
      {l.listing_type === "for_sale" && (
        <ExternalLink className="h-3 w-3 text-primary shrink-0" />
      )}
    </a>
  );
};

/* ═════════════════════════════════════════════════════════════════════════════ */
/* ═══ MAIN COMPONENT ═══════════════════════════════════════════════════════ */
/* ═════════════════════════════════════════════════════════════════════════════ */

export default function PulseIntelligencePanel({
  entityType,
  entityId: propEntityId,
  crmEntityId,
  entityName,
  crmEntity,
}) {
  // Accept both prop shapes (new: entityId, old: crmEntityId)
  const entityId = propEntityId || crmEntityId;
  const [metadataOpen, setMetadataOpen] = useState(false);
  // Tier 4: source-history drill
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
  const navigate = useNavigate();

  /* ── Data hooks ─────────────────────────────────────────────────────────── */
  // PERF NOTE: This loads 5000+ agents, 500 agencies, and 5000 listings client-side
  // just to find 1 entity. This is a known performance issue. Future optimization:
  // move to server-side filtering via RPC/views (e.g. get_pulse_data_for_entity(id)).
  // Both agents and agencies are needed for cross-referencing (agency roster, agent→agency links).
  const { data: pulseMappings = [], loading: mappingsLoading } = useEntityList("PulseCrmMapping", "-created_at");
  const { data: pulseAgents = [], loading: agentsLoading } = useEntityList("PulseAgent", "-last_synced_at", 5000);
  const { data: pulseAgencies = [], loading: agenciesLoading } = useEntityList("PulseAgency", "-last_synced_at", 500);
  const { data: pulseListings = [] } = useEntityList("PulseListing", "-created_at", 5000);
  const { data: pulseTimeline = [] } = useEntityList("PulseTimeline", "-created_at", 500);
  const { data: projects = [] } = useEntityList("Project", "-shoot_date");

  const coreLoading = mappingsLoading || agentsLoading || agenciesLoading;

  /* ── 1. Find CRM mapping ───────────────────────────────────────────────── */
  const mapping = useMemo(() =>
    pulseMappings.find(m => m.crm_entity_id === entityId && m.entity_type === entityType),
    [pulseMappings, entityId, entityType]
  );

  /* ── 2. Find pulse record (ID-first, no name fallback) ─────────────────── */
  const pulseData = useMemo(() => {
    const collection = entityType === "agent" ? pulseAgents : pulseAgencies;
    const idField = entityType === "agent" ? "rea_agent_id" : "rea_agency_id";

    // Step 1: mapping pulse_entity_id -> direct record match
    if (mapping?.pulse_entity_id) {
      const match = collection.find(a => a.id === mapping.pulse_entity_id);
      if (match) return match;
    }
    // Step 2: mapping rea_id -> rea field match
    if (mapping?.rea_id) {
      const match = collection.find(a => a[idField] === mapping.rea_id);
      if (match) return match;
    }
    // Step 3: CRM entity has rea_agent_id / rea_agency_id directly
    if (crmEntity?.[idField]) {
      const match = collection.find(a => a[idField] === crmEntity[idField]);
      if (match) return match;
    }
    // Step 4: Fuzzy name fallback (last resort for manually-added CRM entities)
    if (entityName && entityType === "agent") {
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z\s]/g, "").trim();
      const nameMatch = pulseAgents.find(a => norm(a.full_name) === norm(entityName));
      if (nameMatch) return nameMatch;
    }
    if (entityName && entityType === "agency") {
      const nameMatch = pulseAgencies.find(a => normName(a.name) === normName(entityName));
      if (nameMatch) return nameMatch;
    }
    return null;
  }, [entityType, mapping, pulseAgents, pulseAgencies, crmEntity, entityName]);

  /* ── 3. Filter timeline by entity ──────────────────────────────────────── */
  // NOTE: rea_id is stored as a string in the timeline table, so we coerce
  // all comparisons to string to avoid number/string mismatch bugs.
  const entityTimelineEntries = useMemo(() => {
    if (!entityId) return [];
    return pulseTimeline.filter(t => {
      if (t.crm_entity_id === entityId) return true;
      if (mapping?.rea_id && String(t.rea_id) === String(mapping.rea_id)) return true;
      if (mapping?.pulse_entity_id && t.pulse_entity_id === mapping.pulse_entity_id) return true;
      // Agent entity: match on rea_agent_id
      if (crmEntity?.rea_agent_id && String(t.rea_id) === String(crmEntity.rea_agent_id)) return true;
      // Agency entity: match on rea_agency_id
      if (crmEntity?.rea_agency_id && String(t.rea_id) === String(crmEntity.rea_agency_id)) return true;
      return false;
    });
  }, [pulseTimeline, entityId, mapping, crmEntity]);

  /* ── 4. Agent's / agency's listings (by rea_id) ────────────────────────── */
  const entityListings = useMemo(() => {
    if (!pulseData) return [];
    if (entityType === "agent") {
      const reaId = pulseData.rea_agent_id;
      if (reaId) return pulseListings.filter(l => l.agent_rea_id === reaId);
      return [];
    } else {
      const reaId = pulseData.rea_agency_id;
      if (reaId) {
        const byId = pulseListings.filter(l => l.agency_rea_id === reaId);
        if (byId.length > 0) return byId;
      }
      // Fallback: normalized agency name match on listing
      const name = normName(pulseData.name);
      if (name) return pulseListings.filter(l => normName(l.agency_name) === name);
      return [];
    }
  }, [entityType, pulseData, pulseListings]);

  const activeListings = entityListings.filter(l => l.listing_type === "for_sale" || l.listing_type === "for_rent");
  const forSaleListings = entityListings.filter(l => l.listing_type === "for_sale");
  const forRentListings = entityListings.filter(l => l.listing_type === "for_rent");
  const soldListings = entityListings.filter(l => l.listing_type === "sold");

  /* ── 5. CRM projects for this entity ───────────────────────────────────── */
  const entityProjects = useMemo(() => {
    if (entityType === "agent") {
      return projects.filter(p => p.agent_id === entityId || p.client_id === entityId);
    }
    return projects.filter(p => p.agency_id === entityId);
  }, [projects, entityId, entityType]);

  /* ── 6. Agency agents (roster) ─────────────────────────────────────────── */
  const agencyAgents = useMemo(() => {
    if (entityType !== "agency" || !pulseData) return [];
    if (pulseData.rea_agency_id) {
      const byId = pulseAgents.filter(a => a.agency_rea_id === pulseData.rea_agency_id);
      if (byId.length > 0) return byId.sort((a, b) => (b.sales_as_lead || 0) - (a.sales_as_lead || 0));
    }
    const name = normName(pulseData.name || crmEntity?.name);
    if (name) return pulseAgents.filter(a => normName(a.agency_name) === name)
      .sort((a, b) => (b.sales_as_lead || 0) - (a.sales_as_lead || 0));
    return [];
  }, [entityType, pulseData, crmEntity, pulseAgents]);

  /* ── 7. Sales breakdown ────────────────────────────────────────────────── */
  const salesBreakdown = useMemo(
    () => parseJSON(pulseData?.sales_breakdown),
    [pulseData]
  );

  /* ── 8. Suburbs ────────────────────────────────────────────────────────── */
  const suburbsList = useMemo(
    () => parseArray(pulseData?.suburbs_active),
    [pulseData]
  );

  /* ── 9. Cross-reference: pulse listings matching CRM project addresses ── */
  const projectAddresses = useMemo(
    () => new Set(entityProjects.map(p => normAddr(p.property_address))),
    [entityProjects]
  );
  const crossLinked = entityListings.filter(l => projectAddresses.has(normAddr(l.address)));

  /* ── 10. Agent CRM mapping lookup (for agency roster click-through) ──── */
  // Index by both pulse_entity_id and rea_id so we can find CRM mappings
  // regardless of which ID the agent record has.
  const agentMappingIndex = useMemo(() => {
    const idx = new Map();
    for (const m of pulseMappings) {
      if (m.entity_type === "agent") {
        if (m.pulse_entity_id) idx.set(`pid:${m.pulse_entity_id}`, m);
        if (m.rea_id) idx.set(`rea:${m.rea_id}`, m);
      }
    }
    return idx;
  }, [pulseMappings]);

  /* ── 11. Agency mapping for agent dossier (clickable agency name) ───── */
  const agencyMapping = useMemo(() => {
    if (!pulseData?.agency_rea_id) return null;
    return pulseMappings.find(m => m.entity_type === "agency" && m.rea_id === pulseData.agency_rea_id);
  }, [pulseData, pulseMappings]);

  /* ══════════════════════════════════════════════════════════════════════════ */
  /* ═══ EMPTY STATE ═══════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════════════ */

  if (coreLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!pulseData && !mapping && entityTimelineEntries.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground space-y-2">
        <Database className="h-8 w-8 mx-auto opacity-40" />
        <p className="text-sm font-medium">No Industry Pulse data linked</p>
        <p className="text-xs">
          This {entityType} hasn't been matched to pulse intelligence data yet.
          Run a data sync from Industry Pulse &rarr; Data Sources to populate agent/agency profiles.
        </p>
      </div>
    );
  }

  const a = pulseData; // shorthand

  /* ── Data freshness indicator ───────────────────────────────────────────── */
  const staleDays = a?.last_synced_at
    ? Math.floor((Date.now() - new Date(a.last_synced_at).getTime()) / 86400000)
    : null;

  /* ══════════════════════════════════════════════════════════════════════════ */
  /* ═══ RENDER ═══════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════════════ */

  return (
    <div className="space-y-4">

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ 1. HEADER BAR ═══════════════════════════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex items-center gap-2 flex-wrap text-xs px-1">
        {/* Mapping status */}
        {mapping ? (
          <Badge variant="outline" className={cn("text-[9px] gap-1",
            mapping.confidence === "confirmed"
              ? "text-green-600 border-green-200"
              : "text-amber-600 border-amber-200"
          )}>
            {mapping.confidence === "confirmed"
              ? <CheckCircle2 className="h-3 w-3" />
              : <AlertTriangle className="h-3 w-3" />}
            {mapping.confidence === "confirmed" ? "Confirmed" : "Suggested"}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[9px] text-muted-foreground">Unmapped</Badge>
        )}

        {/* REA ID badge */}
        {a?.rea_agent_id && (
          <Badge variant="outline" className="text-[8px] bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">
            REA {a.rea_agent_id}
          </Badge>
        )}
        {a?.rea_agency_id && (
          <Badge variant="outline" className="text-[8px] bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">
            REA {a.rea_agency_id}
          </Badge>
        )}

        {/* Data integrity score */}
        {a?.data_integrity_score > 0 && (() => {
          const ic = integrityColor(a.data_integrity_score);
          return (
            <Badge variant="outline" className={cn("text-[8px] gap-1", ic.text, ic.border, ic.badge)}>
              <Shield className="h-2.5 w-2.5" />
              {a.data_integrity_score}%
            </Badge>
          );
        })()}

        {/* Stale data warning */}
        {staleDays !== null && staleDays > 7 && (
          <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-300">
            Data {staleDays}d old
          </Badge>
        )}

        {/* Dates - right aligned */}
        <span className="text-[9px] text-muted-foreground ml-auto flex items-center gap-2">
          {a?.first_seen_at && <span>First seen {fmtDate(a.first_seen_at)}</span>}
          {a?.last_synced_at && <span>Synced {fmtDate(a.last_synced_at)}</span>}
        </span>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ AGENT DOSSIER ═══════════════════════════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {entityType === "agent" && a && (<>

        {/* ── 2. Profile Card ──────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              {a.profile_image ? (
                <img
                  src={a.profile_image}
                  alt=""
                  className="h-20 w-20 rounded-full object-cover shrink-0 border"
                />
              ) : (
                <div className="h-20 w-20 rounded-full bg-muted/60 flex items-center justify-center shrink-0 border">
                  <User className="h-8 w-8 text-muted-foreground/40" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-lg leading-tight">{a.full_name}</h3>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {a.job_title && <span className="text-xs text-muted-foreground">{a.job_title}</span>}
                  <Badge variant="outline" className={cn("text-[8px]", positionColor(mapPosition(a.job_title)))}>
                    {mapPosition(a.job_title)}
                  </Badge>
                  {a.years_experience && (
                    <span className="text-[10px] text-muted-foreground">{a.years_experience} yrs exp</span>
                  )}
                </div>

                {/* Agency line */}
                {a.agency_name && (
                  <div className="flex items-center gap-1.5 mt-1 text-xs">
                    <Building2 className="h-3 w-3 text-muted-foreground" />
                    {agencyMapping?.crm_entity_id ? (
                      <a href={`/organisations/${agencyMapping.crm_entity_id}`} className="font-medium text-primary hover:underline">{a.agency_name}</a>
                    ) : (
                      <span className="font-medium">{a.agency_name}</span>
                    )}
                    {a.suburb && <span className="text-muted-foreground">- {a.suburb}</span>}
                  </div>
                )}

                {/* Contact row */}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {a.mobile && (
                    <div className="flex items-center gap-1 text-xs">
                      <Phone className="h-3 w-3 text-muted-foreground" />
                      <a href={`tel:${a.mobile}`} className="text-primary hover:underline">{a.mobile}</a>
                    </div>
                  )}
                  {a.business_phone && !a.mobile && (
                    <div className="flex items-center gap-1 text-xs">
                      <Phone className="h-3 w-3 text-muted-foreground" />
                      <a href={`tel:${a.business_phone}`} className="text-primary hover:underline">{a.business_phone}</a>
                    </div>
                  )}
                  {a.email && (
                    <div className="flex items-center gap-1 text-xs">
                      <Mail className="h-3 w-3 text-muted-foreground" />
                      <a href={`mailto:${a.email}`} className="text-primary hover:underline">{a.email}</a>
                    </div>
                  )}
                  {/* Show additional emails from all_emails JSON array */}
                  {(() => {
                    const allEmails = parseArray(a.all_emails);
                    const extras = allEmails.filter(e => e && e !== a.email);
                    return extras.length > 0 && extras.map(em => (
                      <div key={em} className="flex items-center gap-1 text-xs">
                        <Mail className="h-3 w-3 text-muted-foreground/50" />
                        <a href={`mailto:${em}`} className="text-primary/70 hover:underline">{em}</a>
                      </div>
                    ));
                  })()}
                </div>

                {/* REA profile link */}
                {a.rea_profile_url && (
                  <a
                    href={a.rea_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1.5"
                  >
                    <ExternalLink className="h-3 w-3" /> View REA Profile
                  </a>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── 3. Performance Stats ─────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <SectionHeader icon={TrendingUp}>Performance</SectionHeader>
            <div className="grid grid-cols-3 gap-2">
              <StatBox value={a.sales_as_lead || 0} label="Sales (Lead, 12m)" />
              <StatBox value={fmtPrice(a.avg_sold_price)} label="Avg Sold Price" />
              <StatBox value={a.avg_days_on_market > 0 ? `${a.avg_days_on_market}d` : "\u2014"} label="Avg Days on Market" />
            </div>

            {/* Reviews row */}
            {(a.rea_rating > 0 || a.reviews_count > 0) && (
              <div className="flex items-center gap-3 pt-1">
                <Star className="h-5 w-5 fill-amber-400 text-amber-400" />
                <span className="text-xl font-bold">
                  {Number(a.rea_rating || a.reviews_avg || 0).toFixed(1)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {a.rea_review_count || a.reviews_count || 0} reviews
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 4. Active Listings (For Sale + Rent) ─────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionHeader icon={Home} count={activeListings.length}>Active Listings</SectionHeader>
            {activeListings.length > 0 ? (
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {activeListings.slice(0, 20).map(l => (
                  <ListingRow key={l.id} l={l} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">No active listings found</p>
            )}
          </CardContent>
        </Card>

        {/* ── 5. Recently Sold ─────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionHeader icon={DollarSign} count={soldListings.length}>Recently Sold</SectionHeader>
            {soldListings.length > 0 ? (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {soldListings.slice(0, 20).map(l => (
                  <ListingRow key={l.id} l={l} showSoldInfo />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">No sold listings found</p>
            )}
          </CardContent>
        </Card>

        {/* ── 6. Sales Breakdown ───────────────────────────────────────── */}
        {salesBreakdown && Object.keys(salesBreakdown).length > 0 && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={BarChart3}>Sales by Property Type</SectionHeader>
              <div className="space-y-1.5">
                {Object.entries(salesBreakdown).map(([type, data]) => {
                  const maxCount = Math.max(...Object.values(salesBreakdown).map(d => d.count || 0), 1);
                  const pct = Math.round(((data.count || 0) / maxCount) * 100);
                  return (
                    <div key={type} className="space-y-0.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="capitalize font-medium">{type}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {data.count} sold
                          {data.medianSoldPrice ? ` \u00B7 ${fmtPrice(data.medianSoldPrice)} median` : ""}
                          {data.medianDaysOnSite ? ` \u00B7 ${data.medianDaysOnSite}d DOM` : ""}
                        </span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-red-400 dark:bg-red-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 7. Awards ────────────────────────────────────────────────── */}
        {a.awards && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={Award}>Awards</SectionHeader>
              <div className="text-xs text-muted-foreground whitespace-pre-line bg-amber-50/50 dark:bg-amber-950/10 rounded p-2.5 border border-amber-200/30">
                {a.awards}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 7b. Biography ────────────────────────────────────────── */}
        {a.biography && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={BookOpen}>About</SectionHeader>
              <p className="text-sm text-muted-foreground whitespace-pre-line">{a.biography}</p>
            </CardContent>
          </Card>
        )}

        {/* ── 8. Specialty Suburbs ─────────────────────────────────────── */}
        {suburbsList.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={MapPin}>Specialty Suburbs</SectionHeader>
              <div className="flex flex-wrap gap-1.5">
                {suburbsList.map(s => (
                  <Badge key={s} variant="outline" className="text-[9px] px-2 py-0.5 bg-red-50/50 dark:bg-red-950/10 border-red-200/50 text-red-700 dark:text-red-400">
                    {s}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 9. Social & Profile Links ────────────────────────────────── */}
        {(a.social_facebook || a.social_instagram || a.social_linkedin || a.rea_profile_url) && (
          <Card>
            <CardContent className="p-4 space-y-2">
              {(a.social_facebook || a.social_instagram || a.social_linkedin) && (
                <div>
                  <SectionHeader>Social</SectionHeader>
                  <div className="flex gap-3">
                    {a.social_facebook && (
                      <a href={a.social_facebook} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        <Facebook className="h-3.5 w-3.5" /> Facebook
                      </a>
                    )}
                    {a.social_instagram && (
                      <a href={`https://instagram.com/${a.social_instagram.replace("@", "")}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        <Instagram className="h-3.5 w-3.5" /> Instagram
                      </a>
                    )}
                    {a.social_linkedin && (
                      <a href={a.social_linkedin} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        <Linkedin className="h-3.5 w-3.5" /> LinkedIn
                      </a>
                    )}
                  </div>
                </div>
              )}
              {a.rea_profile_url && (
                <div className="pt-1 border-t">
                  <a href={a.rea_profile_url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink className="h-3 w-3" /> realestate.com.au <REABadge />
                  </a>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── 10. CRM Cross-Reference ──────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionHeader icon={Briefcase} count={entityProjects.length}>CRM Cross-Reference</SectionHeader>
            {mapping ? (
              <Badge variant="outline" className="text-[9px] text-green-600 border-green-200 mb-2">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Mapped to CRM
              </Badge>
            ) : (
              <p className="text-xs text-muted-foreground/60 mb-2">Not in CRM</p>
            )}
            {entityProjects.length > 0 ? (
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
                            "text-muted-foreground"
                          )}>{p.status}</Badge>
                          {p.shoot_date && <span>{fmtDate(p.shoot_date)}</span>}
                        </div>
                      </div>
                      {isCrossLinked && (
                        <Badge className="text-[7px] bg-indigo-100 text-indigo-700 border-0 shrink-0 ml-2">
                          Pulse Match
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : mapping ? (
              <p className="text-xs text-muted-foreground/60">No projects found for this agent</p>
            ) : null}
          </CardContent>
        </Card>

        {/* ── 11. Enrichment Metadata (collapsible) ────────────────────── */}
        <Card>
          <CardContent className="p-0">
            <button
              onClick={() => setMetadataOpen(prev => !prev)}
              className="flex items-center justify-between w-full px-4 py-3 text-xs text-muted-foreground hover:bg-muted/20 transition-colors"
            >
              <span className="font-semibold uppercase flex items-center gap-1.5">
                <Hash className="h-3 w-3" /> Enrichment Metadata
              </span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", metadataOpen && "rotate-180")} />
            </button>
            {metadataOpen && (
              <div className="px-4 pb-3 space-y-2 text-[10px] text-muted-foreground border-t">
                <div className="flex items-center gap-2 pt-2">
                  <span className="font-medium">Source:</span> <REABadge />
                </div>
                {a?.data_integrity_score > 0 && (() => {
                  const ic = integrityColor(a.data_integrity_score);
                  return (
                    <div className="space-y-0.5">
                      <span className="font-medium">Data Integrity: <span className={ic.text}>{a.data_integrity_score}%</span></span>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden w-32">
                        <div className={cn("h-full rounded-full", ic.bg)} style={{ width: `${a.data_integrity_score}%` }} />
                      </div>
                    </div>
                  );
                })()}
                <div className="flex items-center gap-4 flex-wrap">
                  <span>First detected: {fmtDate(a?.first_seen_at)}</span>
                  <span>Last synced: {fmtDate(a?.last_synced_at)}</span>
                </div>
                {/* Tier 4: last_sync_log_id drill + full source history */}
                {a?.last_sync_log_id && (
                  <p>
                    Last sync run:{" "}
                    <a
                      href={`/IndustryPulse?tab=sources&sync_log_id=${a.last_sync_log_id}`}
                      className="font-mono text-primary hover:underline inline-flex items-center gap-0.5"
                      title="Open payload for this run"
                    >
                      {String(a.last_sync_log_id).slice(0, 8)}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </p>
                )}
                {a?.rea_agent_id && <p>REA Agent ID: <span className="font-mono">{a.rea_agent_id}</span></p>}
                {a?.agency_rea_id && <p>REA Agency ID: <span className="font-mono">{a.agency_rea_id}</span></p>}
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-7 text-[10px]"
                    onClick={() => setSyncHistoryOpen(true)}
                    title="See which sync runs touched this agent"
                  >
                    <History className="h-3 w-3" />
                    View full source history
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </>)}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ AGENCY DOSSIER ══════════════════════════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {entityType === "agency" && a && (<>

        {/* ── 2. Agency Profile Card ───────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              {a.logo_url ? (
                <img src={a.logo_url} alt="" className="h-14 w-24 object-contain shrink-0 rounded border bg-white" />
              ) : (
                <div className="h-14 w-24 rounded border bg-muted/40 flex items-center justify-center shrink-0">
                  <Building2 className="h-6 w-6 text-muted-foreground/40" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-lg leading-tight">{a.name}</h3>
                {(a.suburb || a.address) && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                    <MapPin className="h-3 w-3" />
                    {a.address || a.suburb}
                    {a.state ? `, ${a.state}` : ""}
                    {a.postcode ? ` ${a.postcode}` : ""}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {a.phone && (
                    <div className="flex items-center gap-1 text-xs">
                      <Phone className="h-3 w-3 text-muted-foreground" />
                      <a href={`tel:${a.phone}`} className="text-primary hover:underline">{a.phone}</a>
                    </div>
                  )}
                  {a.email && (
                    <div className="flex items-center gap-1 text-xs">
                      <Mail className="h-3 w-3 text-muted-foreground" />
                      <a href={`mailto:${a.email}`} className="text-primary hover:underline">{a.email}</a>
                    </div>
                  )}
                  {a.website && (
                    <div className="flex items-center gap-1 text-xs">
                      <Globe className="h-3 w-3 text-muted-foreground" />
                      <a
                        href={a.website.startsWith("http") ? a.website : `https://${a.website}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-primary hover:underline truncate max-w-[200px]"
                      >{a.website}</a>
                    </div>
                  )}
                </div>
                {a.rea_profile_url && (
                  <a
                    href={a.rea_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-1.5"
                  >
                    <ExternalLink className="h-3 w-3" /> View REA Profile
                  </a>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── 3. Key Metrics (4-col grid) ──────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionHeader icon={TrendingUp}>Key Metrics</SectionHeader>
            <div className="grid grid-cols-4 gap-2">
              <StatBox value={agencyAgents.length || a.agent_count || 0} label="Total Agents" />
              <StatBox value={a.active_listings || 0} label="Active Listings" />
              <StatBox value={a.total_sold_12m || 0} label="Sold (12m)" />
              <StatBox
                value={a.avg_agent_rating ? Number(a.avg_agent_rating).toFixed(1) : "\u2014"}
                label="Avg Agent Rating"
              />
            </div>
          </CardContent>
        </Card>

        {/* ── 4. Agent Roster ──────────────────────────────────────────── */}
        {agencyAgents.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={Users} count={agencyAgents.length}>Agent Roster</SectionHeader>
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
                    {agencyAgents.slice(0, 30).map(ag => {
                      const agMapping = agentMappingIndex.get(`pid:${ag.id}`) || (ag.rea_agent_id ? agentMappingIndex.get(`rea:${ag.rea_agent_id}`) : null);
                      const hasCrm = !!agMapping?.crm_entity_id;
                      return (
                        <tr
                          key={ag.id}
                          className={cn("border-t hover:bg-muted/20", hasCrm && "cursor-pointer")}
                          // Tier 3: drill through to CRM record without losing
                          // the current tab/state — use client-side nav.
                          onClick={hasCrm ? () => navigate(`/people/${agMapping.crm_entity_id}`) : undefined}
                        >
                          <td className="px-2 py-1.5">
                            <p className="font-medium">{ag.full_name}</p>
                            {ag.job_title && <p className="text-[9px] text-muted-foreground">{ag.job_title}</p>}
                          </td>
                          <td className="px-2 py-1.5">
                            <Badge variant="outline" className={cn("text-[8px]", positionColor(mapPosition(ag.job_title)))}>
                              {mapPosition(ag.job_title)}
                            </Badge>
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">{ag.sales_as_lead || 0}</td>
                          <td className="px-2 py-1.5">
                            {(ag.rea_rating || ag.reviews_avg) > 0 ? (
                              <span className="flex items-center gap-0.5">
                                <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                                {Number(ag.rea_rating || ag.reviews_avg).toFixed(1)}
                              </span>
                            ) : "\u2014"}
                          </td>
                          <td className="px-2 py-1.5">
                            {hasCrm ? (
                              <Badge className="text-[7px] bg-green-100 text-green-700 border-0 px-1 py-0">CRM</Badge>
                            ) : (
                              <span className="text-[7px] text-muted-foreground/40">--</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 5. Agency Listings ───────────────────────────────────────── */}
        {forSaleListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={Home} count={forSaleListings.length}>For Sale</SectionHeader>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {forSaleListings.slice(0, 20).map(l => (
                  <ListingRow key={l.id} l={l} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {forRentListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={Home} count={forRentListings.length}>For Rent</SectionHeader>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {forRentListings.slice(0, 20).map(l => (
                  <ListingRow key={l.id} l={l} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {soldListings.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={DollarSign} count={soldListings.length}>Recently Sold</SectionHeader>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {soldListings.slice(0, 20).map(l => (
                  <ListingRow key={l.id} l={l} showSoldInfo />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 6. Active Suburbs ────────────────────────────────────────── */}
        {suburbsList.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <SectionHeader icon={MapPin}>Active Suburbs</SectionHeader>
              <div className="flex flex-wrap gap-1.5">
                {suburbsList.map(s => (
                  <Badge key={s} variant="outline" className="text-[9px] px-2 py-0.5 bg-red-50/50 dark:bg-red-950/10 border-red-200/50 text-red-700 dark:text-red-400">
                    {s}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── 7. Enrichment Metadata (collapsible) ─────────────────────── */}
        <Card>
          <CardContent className="p-0">
            <button
              onClick={() => setMetadataOpen(prev => !prev)}
              className="flex items-center justify-between w-full px-4 py-3 text-xs text-muted-foreground hover:bg-muted/20 transition-colors"
            >
              <span className="font-semibold uppercase flex items-center gap-1.5">
                <Hash className="h-3 w-3" /> Enrichment Metadata
              </span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", metadataOpen && "rotate-180")} />
            </button>
            {metadataOpen && (
              <div className="px-4 pb-3 space-y-2 text-[10px] text-muted-foreground border-t">
                <div className="flex items-center gap-2 pt-2">
                  <span className="font-medium">Source:</span> <REABadge />
                </div>
                {a?.data_integrity_score > 0 && (() => {
                  const ic = integrityColor(a.data_integrity_score);
                  return (
                    <div className="space-y-0.5">
                      <span className="font-medium">Data Integrity: <span className={ic.text}>{a.data_integrity_score}%</span></span>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden w-32">
                        <div className={cn("h-full rounded-full", ic.bg)} style={{ width: `${a.data_integrity_score}%` }} />
                      </div>
                    </div>
                  );
                })()}
                <div className="flex items-center gap-4 flex-wrap">
                  <span>First detected: {fmtDate(a?.first_seen_at)}</span>
                  <span>Last synced: {fmtDate(a?.last_synced_at)}</span>
                </div>
                {/* Tier 4: last_sync_log_id drill + full source history */}
                {a?.last_sync_log_id && (
                  <p>
                    Last sync run:{" "}
                    <a
                      href={`/IndustryPulse?tab=sources&sync_log_id=${a.last_sync_log_id}`}
                      className="font-mono text-primary hover:underline inline-flex items-center gap-0.5"
                      title="Open payload for this run"
                    >
                      {String(a.last_sync_log_id).slice(0, 8)}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </p>
                )}
                {a?.rea_agency_id && <p>REA Agency ID: <span className="font-mono">{a.rea_agency_id}</span></p>}
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-7 text-[10px]"
                    onClick={() => setSyncHistoryOpen(true)}
                    title="See which sync runs touched this agency"
                  >
                    <History className="h-3 w-3" />
                    View full source history
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </>)}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ═══ 12. TIMELINE (both entity types) ═══════════════════════════ */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <Card>
        <CardContent className="p-4">
          <SectionHeader icon={Clock}>Intelligence Timeline</SectionHeader>
          <PulseTimeline
            entries={entityTimelineEntries}
            maxHeight="max-h-[500px]"
            emptyMessage={`No timeline events for this ${entityType} yet. Events will appear after data syncs detect changes.`}
          />
        </CardContent>
      </Card>

      {/* Tier 4: source history dialog */}
      {syncHistoryOpen && a && (
        <EntitySyncHistoryDialog
          entityType={entityType}
          entityId={a.id}
          entityLabel={a.full_name || a.name || entityName}
          onClose={() => setSyncHistoryOpen(false)}
        />
      )}
    </div>
  );
}

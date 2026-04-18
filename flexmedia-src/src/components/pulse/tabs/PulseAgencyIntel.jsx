/**
 * PulseAgencyIntel — Agency Intelligence Tab
 * REA-only. Tabular agency roster with live agent counts, full-detail slideout.
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Building2,
  Star,
  ExternalLink,
  Phone,
  Mail,
  MapPin,
  Globe,
  Users,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Hash,
  Home,
  ChevronUp,
  ChevronDown,
  X,
  Activity,
  UserPlus,
  Download,
  Clock,
  Loader2,
} from "lucide-react";
import PulseTimeline from "@/components/pulse/PulseTimeline";
import {
  displayPrice as sharedDisplayPrice,
  LISTING_TYPE_LABEL,
  listingTypeBadgeClasses,
  reaIdEquals,
} from "@/components/pulse/utils/listingHelpers";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  return v >= 1_000_000
    ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
    ? `$${Math.round(v / 1_000)}K`
    : `$${v}`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function normAgencyKey(s) {
  return (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function fmtAgo(d) {
  if (!d) return "—";
  const t = new Date(d).getTime();
  if (isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d2 = Math.floor(h / 24);
  if (d2 < 30) return `${d2}d ago`;
  const mo = Math.floor(d2 / 30);
  return `${mo}mo ago`;
}

function exportCsv(filename, header, rows) {
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseArray(val) {
  if (!val) return [];
  try {
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapPosition(jobTitle) {
  const jt = (jobTitle || "").toLowerCase();
  if (
    jt.includes("principal") ||
    jt.includes("director") ||
    jt.includes("managing") ||
    jt.includes("licensee") ||
    jt.includes("owner") ||
    jt.includes("ceo") ||
    jt.includes("partner")
  )
    return "Partner";
  if (
    jt.includes("senior") ||
    jt.includes("manager") ||
    jt.includes("head of") ||
    jt.includes("auctioneer")
  )
    return "Senior";
  return jt.includes("associate") ? "Associate" : "Junior";
}

function positionColor(pos) {
  if (pos === "Partner")
    return "text-blue-600 border-blue-200 dark:text-blue-400 dark:border-blue-800";
  if (pos === "Senior")
    return "text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-800";
  if (pos === "Associate")
    return "text-violet-600 border-violet-200 dark:text-violet-400 dark:border-violet-800";
  return "text-gray-500 border-gray-200 dark:text-gray-400 dark:border-gray-800";
}

/* ── Small shared UI atoms ────────────────────────────────────────────────── */

const REABadge = () => (
  <span className="text-[7px] font-bold uppercase px-1 py-0 rounded inline-block leading-relaxed bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
    REA
  </span>
);

const SortIcon = ({ col, current, dir }) => {
  if (current !== col)
    return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40 ml-0.5 inline" />;
  return dir === "asc" ? (
    <ChevronUp className="h-3 w-3 text-primary ml-0.5 inline" />
  ) : (
    <ChevronDown className="h-3 w-3 text-primary ml-0.5 inline" />
  );
};

const StarRating = ({ value }) => {
  if (!value || value <= 0) return <span className="text-muted-foreground/50">—</span>;
  return (
    <span className="flex items-center gap-0.5">
      <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
      <span>{Number(value).toFixed(1)}</span>
    </span>
  );
};

const CrmBadge = ({ inCrm }) =>
  inCrm ? (
    <Badge className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 border-0 dark:bg-emerald-900/30 dark:text-emerald-400">
      In CRM
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="text-[9px] px-1.5 py-0 text-muted-foreground border-dashed"
    >
      Not in CRM
    </Badge>
  );

const StatBox = ({ label, value, sub }) => (
  <div className="bg-muted/40 rounded-lg p-3 text-center">
    <p className="text-lg font-bold tabular-nums leading-none">{value}</p>
    {sub && <p className="text-[9px] text-primary mt-0.5">{sub}</p>}
    <p className="text-[9px] text-muted-foreground mt-0.5">{label}</p>
  </div>
);

/* ── Listing row ─────────────────────────────────────────────────────────── */

const ListingRow = ({ l, onOpen }) => {
  const isSold = l.listing_type === "sold";
  const isRent = l.listing_type === "for_rent";
  const isUnderContract = l.listing_type === "under_contract";

  // Shared canonical price label — handles sold / for_rent / under_contract
  // ordering + the /wk suffix consistently. Previous inline branches diverged.
  const priceLabel = sharedDisplayPrice(l).label;

  // Body row content — shared between onOpen and link variants.
  const bodyMeta = (
    <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
      {l.suburb && <span>{l.suburb}</span>}
      {isSold ? (
        <>
          {priceLabel && priceLabel !== "—" && (
            <span className="font-medium text-foreground">{priceLabel}</span>
          )}
          {l.sold_date && (
            <span className="text-[9px]">Sold {fmtDate(l.sold_date)}</span>
          )}
        </>
      ) : (
        <>
          {priceLabel && priceLabel !== "—" && (
            <span className="font-medium text-foreground">{priceLabel}</span>
          )}
          {l.bedrooms > 0 && <span>{l.bedrooms}bd</span>}
          {l.bathrooms > 0 && <span>{l.bathrooms}ba</span>}
        </>
      )}
    </div>
  );

  // Status badges — render one branch per state. under_contract uses amber
  // classes from the shared listingTypeBadgeClasses helper.
  const statusBadges = (
    <>
      {isSold && (
        <Badge className="text-[7px] py-0 px-1 bg-emerald-100 text-emerald-700 border-0">
          Sold
        </Badge>
      )}
      {isRent && (
        <Badge
          variant="outline"
          className="text-[7px] py-0 px-1 text-purple-600 border-purple-200"
        >
          Rent
        </Badge>
      )}
      {isUnderContract && (() => {
        const c = listingTypeBadgeClasses("under_contract");
        return (
          <Badge
            variant="outline"
            className={cn("text-[7px] py-0 px-1", c.text, c.border)}
          >
            {LISTING_TYPE_LABEL.under_contract}
          </Badge>
        );
      })()}
    </>
  );

  if (onOpen) {
    return (
      <button
        onClick={() => onOpen(l)}
        className="w-full flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors text-left"
      >
        {l.image_url ? (
          <img
            src={l.image_url}
            alt=""
            className="h-9 w-14 object-cover rounded shrink-0"
          />
        ) : (
          <div className="h-9 w-14 bg-muted rounded shrink-0 flex items-center justify-center">
            <Home className="h-3.5 w-3.5 text-muted-foreground/40" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{l.address || l.suburb || "—"}</p>
          {bodyMeta}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {statusBadges}
          {!isSold && !isRent && !isUnderContract && (
            <ChevronRight className="h-3 w-3 text-primary" />
          )}
        </div>
      </button>
    );
  }

  return (
    <a
      href={l.source_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/30 transition-colors"
    >
      {l.image_url ? (
        <img
          src={l.image_url}
          alt=""
          className="h-9 w-14 object-cover rounded shrink-0"
        />
      ) : (
        <div className="h-9 w-14 bg-muted rounded shrink-0 flex items-center justify-center">
          <Home className="h-3.5 w-3.5 text-muted-foreground/40" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{l.address || l.suburb || "—"}</p>
        {bodyMeta}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {statusBadges}
        {!isSold && !isRent && !isUnderContract && (
          <ExternalLink className="h-3 w-3 text-primary" />
        )}
      </div>
    </a>
  );
};

/* ── Agent row (within slideout) ─────────────────────────────────────────── */

const AgentRow = ({ agent, isInCrm, isSelected, onSelect, crmEntityId }) => {
  const pos = mapPosition(agent.job_title);
  return (
    <button
      onClick={() => onSelect(isSelected ? null : agent)}
      className={cn(
        "w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors hover:bg-muted/40",
        isSelected && "bg-muted/60 ring-1 ring-primary/20"
      )}
    >
      {agent.profile_image ? (
        <img
          src={agent.profile_image}
          alt={agent.full_name}
          className="h-8 w-8 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Users className="h-3.5 w-3.5 text-muted-foreground/40" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium truncate">{agent.full_name || "—"}</span>
          {pos !== "Junior" && (
            <Badge
              variant="outline"
              className={cn("text-[7px] py-0 px-1 shrink-0", positionColor(pos))}
            >
              {pos}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
          {agent.job_title && <span className="truncate max-w-[120px]">{agent.job_title}</span>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0 text-[10px]">
        {(agent.sales_as_lead > 0 || agent.total_listings_active > 0) && (
          <span className="text-muted-foreground tabular-nums">
            {(agent.sales_as_lead || agent.total_sold_12m) > 0 && `${agent.sales_as_lead || agent.total_sold_12m} sold`}
            {agent.total_listings_active > 0 && ` · ${agent.total_listings_active} active`}
          </span>
        )}
        {agent.avg_sold_price > 0 && (
          <span className="font-medium text-foreground">{fmtPrice(agent.avg_sold_price)}</span>
        )}
        {(agent.rea_rating || agent.reviews_avg) > 0 && (
          <span className="flex items-center gap-0.5 text-amber-500">
            <Star className="h-2.5 w-2.5 fill-amber-400" />
            {Number(agent.rea_rating || agent.reviews_avg).toFixed(1)}
          </span>
        )}
        <CrmBadge inCrm={!!isInCrm} />
        {isInCrm && crmEntityId && (
          <a
            href={`/people/${crmEntityId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-primary hover:underline text-[9px] flex items-center gap-0.5"
            title="View in CRM"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
    </button>
  );
};

/* ── Mini agent profile (inline, within slideout) ────────────────────────── */

const AgentMiniProfile = ({ agent, onClose }) => {
  const pos = mapPosition(agent.job_title);
  return (
    <div className="mt-2 p-3 rounded-xl border bg-card shadow-sm animate-in slide-in-from-top-1 duration-150">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          {agent.profile_image ? (
            <img
              src={agent.profile_image}
              alt={agent.full_name}
              className="h-12 w-12 rounded-full object-cover shrink-0"
            />
          ) : (
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center shrink-0">
              <Users className="h-5 w-5 text-muted-foreground/40" />
            </div>
          )}
          <div>
            <p className="font-semibold text-sm">{agent.full_name || "—"}</p>
            {agent.job_title && (
              <p className="text-xs text-muted-foreground">{agent.job_title}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {pos !== "Junior" && (
                <Badge
                  variant="outline"
                  className={cn("text-[7px] py-0 px-1", positionColor(pos))}
                >
                  {pos}
                </Badge>
              )}
              <REABadge />
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted transition-colors shrink-0"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <StatBox label="Sold (12m)" value={agent.sales_as_lead > 0 ? agent.sales_as_lead : "—"} />
        <StatBox
          label="Avg Price"
          value={fmtPrice(agent.avg_sold_price)}
        />
        <StatBox
          label="Rating"
          value={
            (agent.rea_rating || agent.reviews_avg) > 0 ? (
              <span className="flex items-center justify-center gap-0.5">
                <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
                {Number(agent.rea_rating || agent.reviews_avg).toFixed(1)}
              </span>
            ) : (
              "—"
            )
          }
        />
      </div>

      <div className="flex flex-wrap gap-2 mt-3 text-xs">
        {(agent.mobile || agent.business_phone) && (
          <a
            href={`tel:${agent.mobile || agent.business_phone}`}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Phone className="h-3 w-3" />
            {agent.mobile || agent.business_phone}
          </a>
        )}
        {agent.email && (
          <a
            href={`mailto:${agent.email}`}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Mail className="h-3 w-3" />
            {agent.email}
          </a>
        )}
        {agent.rea_profile_url && (
          <a
            href={agent.rea_profile_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-red-500 hover:text-red-600 transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            REA Profile
          </a>
        )}
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ═══ AGENCY SLIDEOUT ══════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════ */

export function AgencySlideout({
  agency,
  pulseAgents,
  pulseListings,
  pulseTimeline,
  crmAgencies,
  pulseMappings,
  onClose,
  onOpenEntity,
  hasHistory = false,
  onBack,
}) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [addingToCrm, setAddingToCrm] = useState(false);

  /* Check if already in CRM */
  const existingCrmAgency = useMemo(
    () => crmAgencies.find((c) => normAgencyKey(c.name) === normAgencyKey(agency?.name)),
    [crmAgencies, agency]
  );

  /* Tier 3 drill-through: look up CRM mapping so the "In CRM" badge links to
     the CRM Organisation record (OrgDetails). */
  const crmAgencyMapping = useMemo(() => {
    if (!agency?.is_in_crm || !pulseMappings) return null;
    return pulseMappings.find(
      (m) =>
        m.entity_type === "agency" &&
        (m.pulse_entity_id === agency.id ||
          (m.rea_id && agency.rea_agency_id && String(m.rea_id) === String(agency.rea_agency_id)))
    );
  }, [agency, pulseMappings]);

  /* Add agency to CRM handler */
  async function handleAddAgencyToCrm() {
    if (!agency) return;
    setAddingToCrm(true);
    try {
      const newAgency = await api.entities.Agency.create({
        name: agency.name,
        phone: agency.phone || null,
        email: agency.email || null,
        website: agency.website || null,
        rea_agency_id: agency.rea_agency_id || null,
        source: "pulse",
        relationship_state: "Prospecting",
      });

      // Create mapping
      await api.entities.PulseCrmMapping.create({
        entity_type: "agency",
        pulse_entity_id: agency.id,
        crm_entity_id: newAgency.id,
        rea_id: agency.rea_agency_id,
        match_type: "manual",
        confidence: "confirmed",
      });

      // Mark pulse agency as in_crm
      await api.entities.PulseAgency.update(agency.id, { is_in_crm: true });

      await refetchEntityList("PulseAgency");
      await refetchEntityList("Agency");
      await refetchEntityList("PulseCrmMapping");

      toast.success(`${agency.name} added to CRM`);
      onClose();
    } catch (err) {
      console.error("Add agency to CRM failed:", err);
      toast.error("Failed to add agency to CRM. Please try again.");
    } finally {
      setAddingToCrm(false);
    }
  }

  /* Look up CRM entity ID for an agent via mappings */
  function getCrmEntityIdForAgent(pulseAgent) {
    if (!pulseAgent || !pulseMappings) return null;
    const mapping = pulseMappings.find(
      (m) =>
        m.entity_type === "agent" &&
        (m.pulse_entity_id === pulseAgent.id ||
          (m.rea_id && m.rea_id === pulseAgent.rea_agent_id))
    );
    return mapping?.crm_entity_id || null;
  }

  /* roster */
  const roster = useMemo(() => {
    if (!agency) return [];
    if (agency.rea_agency_id) {
      const byId = pulseAgents.filter(
        (a) => a.agency_rea_id === agency.rea_agency_id
      );
      if (byId.length > 0)
        return byId.sort((a, b) => (b.sales_as_lead || 0) - (a.sales_as_lead || 0));
    }
    const key = normAgencyKey(agency.name);
    if (key)
      return pulseAgents
        .filter((a) => normAgencyKey(a.agency_name) === key)
        .sort((a, b) => (b.sales_as_lead || 0) - (a.sales_as_lead || 0));
    return [];
  }, [agency, pulseAgents]);

  /* CRM lookup for agents */
  const crmAgentIds = useMemo(() => {
    const s = new Set();
    /* We don't have CRM agent data here so we rely on is_in_crm flag on pulseAgent */
    roster.forEach((a) => {
      if (a.is_in_crm) s.add(a.id);
    });
    return s;
  }, [roster]);

  /* listings */
  const agencyListings = useMemo(() => {
    if (!agency) return [];
    if (agency.rea_agency_id) {
      const byId = pulseListings.filter(
        (l) => l.agency_rea_id === agency.rea_agency_id
      );
      if (byId.length > 0) return byId;
    }
    /* Fallback: check if listing's agent belongs to this agency's roster */
    const rosterIds = new Set(roster.map((a) => a.rea_agent_id).filter(Boolean));
    const byAgent = pulseListings.filter(
      (l) => l.agent_rea_id && rosterIds.has(l.agent_rea_id)
    );
    if (byAgent.length > 0) return byAgent;
    /* Last resort: normalized name match on listing.agency_name */
    const key = normAgencyKey(agency.name);
    if (key) return pulseListings.filter((l) => normAgencyKey(l.agency_name) === key);
    return [];
  }, [agency, pulseListings, roster]);

  const forSale = agencyListings.filter((l) => l.listing_type === "for_sale").slice(0, 10);
  const forRent = agencyListings.filter((l) => l.listing_type === "for_rent").slice(0, 10);
  const sold = agencyListings.filter((l) => l.listing_type === "sold").slice(0, 10);

  /* suburbs */
  const suburbs = useMemo(() => parseArray(agency?.suburbs_active), [agency]);

  const isInCrm = !!agency?.is_in_crm;

  if (!agency) return null;

  return (
    <Dialog open={!!agency} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl w-full max-h-[90vh] overflow-y-auto p-0">
        {/* ── Header ── */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-5 py-4">
          <DialogHeader>
            <DialogTitle asChild>
              <div className="flex items-start gap-3">
                {/* Back */}
                {hasHistory && onBack && (
                  <button
                    onClick={onBack}
                    className="p-1.5 -ml-1 rounded-lg hover:bg-muted transition-colors shrink-0"
                    title="Back"
                  >
                    <ChevronLeft className="h-4 w-4 text-muted-foreground" />
                  </button>
                )}
                {/* Logo */}
                <div className="h-12 w-12 rounded-xl overflow-hidden bg-muted flex items-center justify-center shrink-0 border">
                  {agency.logo_url ? (
                    <img
                      src={agency.logo_url}
                      alt={agency.name}
                      className="h-full w-full object-contain p-1"
                    />
                  ) : (
                    <Building2 className="h-5 w-5 text-muted-foreground/40" />
                  )}
                </div>
                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <h2 className="text-base font-bold leading-tight truncate">
                      {agency.name || "—"}
                    </h2>
                    <REABadge />
                    {/* Tier 3: when mapped, the In CRM badge links to OrgDetails. */}
                    {isInCrm && crmAgencyMapping?.crm_entity_id ? (
                      <a
                        href={`/organisations/${crmAgencyMapping.crm_entity_id}`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 px-1.5 py-0 text-[9px] font-medium leading-4 hover:underline"
                        title="Open CRM record"
                      >
                        In CRM
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    ) : (
                      <CrmBadge inCrm={isInCrm} />
                    )}
                  </div>
                  {agency.suburb && (
                    <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {agency.suburb}
                      {agency.state && `, ${agency.state}`}
                    </p>
                  )}
                </div>
                {/* Close */}
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-muted transition-colors shrink-0"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            </DialogTitle>
          </DialogHeader>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* ── Contact ── */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2">
              Contact
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
              {agency.phone && (
                <a
                  href={`tel:${agency.phone}`}
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Phone className="h-3.5 w-3.5 text-primary" />
                  {agency.phone}
                </a>
              )}
              {agency.email && (
                <a
                  href={`mailto:${agency.email}`}
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Mail className="h-3.5 w-3.5 text-primary" />
                  {agency.email}
                </a>
              )}
              {agency.website && (
                <a
                  href={agency.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Globe className="h-3.5 w-3.5 text-primary" />
                  {agency.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              )}
              {agency.address && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 text-primary" />
                  {agency.address}
                </span>
              )}
              {agency.rea_profile_url && (
                <a
                  href={agency.rea_profile_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-red-500 hover:text-red-600 transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  REA Profile
                </a>
              )}
            </div>
          </section>

          {/* ── Stats grid ── */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2">
              Performance
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatBox
                label="Agents"
                value={
                  agency.live_agent_count > 0
                    ? agency.live_agent_count
                    : agency.agent_count || "—"
                }
              />
              <StatBox
                label="Active Listings"
                value={agency.active_listings > 0 ? agency.active_listings : "—"}
              />
              <StatBox
                label="Sold (12m)"
                value={agency.total_sold_12m > 0 ? agency.total_sold_12m : "—"}
              />
              <StatBox
                label="Avg Rating"
                value={
                  agency.avg_agent_rating > 0 ? (
                    <span className="flex items-center justify-center gap-0.5">
                      <Star className="h-4 w-4 text-amber-400 fill-amber-400" />
                      {Number(agency.avg_agent_rating).toFixed(1)}
                    </span>
                  ) : (
                    "—"
                  )
                }
                sub={
                  agency.total_reviews > 0
                    ? `${agency.total_reviews} reviews`
                    : undefined
                }
              />
            </div>
          </section>

          {/* ── Active Suburbs ── */}
          {suburbs.length > 0 && (
            <section>
              <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2">
                Active Suburbs
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {suburbs.map((sub, i) => (
                  <Badge
                    key={i}
                    variant="secondary"
                    className="text-[10px] py-0.5 px-2 bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800"
                  >
                    {sub}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          {/* ── Agent Roster ── */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              Agent Roster
              {roster.length > 0 && (
                <Badge
                  variant="outline"
                  className="text-[8px] py-0 px-1 ml-1 tabular-nums"
                >
                  {roster.length}
                </Badge>
              )}
            </h3>
            {roster.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No agents found.</p>
            ) : (
              <div className="space-y-0.5">
                {roster.map((agent) => (
                  <React.Fragment key={agent.id}>
                    <AgentRow
                      agent={agent}
                      isInCrm={agent.is_in_crm}
                      isSelected={selectedAgent?.id === agent.id}
                      onSelect={
                        onOpenEntity
                          ? (a) => a && onOpenEntity({ type: "agent", id: a.id })
                          : setSelectedAgent
                      }
                      crmEntityId={agent.is_in_crm ? getCrmEntityIdForAgent(agent) : null}
                    />
                    {!onOpenEntity && selectedAgent?.id === agent.id && (
                      <AgentMiniProfile
                        agent={agent}
                        onClose={() => setSelectedAgent(null)}
                      />
                    )}
                  </React.Fragment>
                ))}
              </div>
            )}
          </section>

          {/* ── Listings ── */}
          {(forSale.length > 0 || forRent.length > 0 || sold.length > 0) && (
            <section>
              <h3 className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-2 flex items-center gap-1.5">
                <Home className="h-3.5 w-3.5" />
                Listings
                <Badge
                  variant="outline"
                  className="text-[8px] py-0 px-1 ml-1 tabular-nums"
                >
                  {agencyListings.length}
                </Badge>
              </h3>
              <div className="space-y-3">
                {forSale.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 mb-1">
                      For Sale ({forSale.length})
                    </p>
                    <div className="space-y-0.5">
                      {forSale.map((l) => (
                        <ListingRow
                          key={l.id}
                          l={l}
                          onOpen={onOpenEntity ? (lst) => onOpenEntity({ type: "listing", id: lst.id }) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {forRent.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-purple-600 dark:text-purple-400 mb-1">
                      For Rent ({forRent.length})
                    </p>
                    <div className="space-y-0.5">
                      {forRent.map((l) => (
                        <ListingRow
                          key={l.id}
                          l={l}
                          onOpen={onOpenEntity ? (lst) => onOpenEntity({ type: "listing", id: lst.id }) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {sold.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-blue-600 dark:text-blue-400 mb-1">
                      Sold ({sold.length})
                    </p>
                    <div className="space-y-0.5">
                      {sold.map((l) => (
                        <ListingRow
                          key={l.id}
                          l={l}
                          onOpen={onOpenEntity ? (lst) => onOpenEntity({ type: "listing", id: lst.id }) : undefined}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── Timeline ── */}
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Timeline
            </h4>
            <PulseTimeline
              entries={(pulseTimeline || []).filter(e =>
                // reaIdEquals coerces both sides to string — rea_id drifts
                // between text + int shapes and strict === silently missed matches.
                reaIdEquals(e.rea_id, agency?.rea_agency_id) ||
                e.pulse_entity_id === agency?.id
              )}
              maxHeight="max-h-[300px]"
              emptyMessage="No timeline events for this agency"
              compact
            />
          </div>

          {/* ── Enrichment Metadata (collapsed) ── */}
          <section>
            <button
              onClick={() => setMetaOpen((p) => !p)}
              className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground/60 hover:text-muted-foreground transition-colors w-full"
            >
              {metaOpen ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Enrichment Metadata
            </button>
            {metaOpen && (
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-medium uppercase">Source</span>
                  <REABadge />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-medium uppercase">Synced</span>
                  <span>{fmtDate(agency.last_synced_at || agency.updated_at)}</span>
                </div>
                {agency.rea_agency_id && (
                  <div className="col-span-2 flex items-center gap-1.5">
                    <Hash className="h-3 w-3 shrink-0" />
                    <span className="font-mono text-[10px] break-all">
                      {agency.rea_agency_id}
                    </span>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* ── Footer with Add to CRM ── */}
        <div className="sticky bottom-0 bg-background border-t border-border px-5 py-3 flex items-center justify-between gap-3">
          {!isInCrm && !existingCrmAgency && (
            <Button
              size="sm"
              onClick={handleAddAgencyToCrm}
              disabled={addingToCrm}
              className="gap-1.5"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {addingToCrm ? "Adding..." : "Add to CRM"}
            </Button>
          )}
          {(isInCrm || existingCrmAgency) && (
            <span className="text-xs text-muted-foreground">Already in CRM</span>
          )}
          {agency.rea_profile_url && (
            <a
              href={agency.rea_profile_url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto"
            >
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" />
                View REA Profile
              </Button>
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ═══ MAIN COMPONENT ════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════ */

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

// UI sort-col → DB column. `live_agent_count` is a client-enrichment over
// `agent_count` that includes only "live" agents; PostgREST can only sort
// on real columns so we sort by `agent_count` as the closest equivalent.
const AGENCY_SERVER_SORT_MAP = {
  live_agent_count: "agent_count",
  agent_count: "agent_count",
  active_listings: "active_listings",
  total_sold_12m: "total_sold_12m",
  avg_sold_price: "avg_sold_price",
  avg_agent_rating: "avg_agent_rating",
  name: "name",
  suburb: "suburb",
};

const CSV_EXPORT_CAP_AGENCIES = 10000;

// localStorage — page-size choice + auto-refresh toggle persist per-tab.
const LS_PAGE_SIZE_KEY = "pulse_agencies_page_size";
const LS_AUTO_REFRESH_KEY = "pulse_agencies_auto_refresh";
const AUTO_REFRESH_INTERVAL_MS = 60_000;

function readStoredPageSize() {
  if (typeof window === "undefined") return 50;
  const raw = Number(window.localStorage.getItem(LS_PAGE_SIZE_KEY));
  return PAGE_SIZE_OPTIONS.includes(raw) ? raw : 50;
}
function readStoredAutoRefresh() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LS_AUTO_REFRESH_KEY) === "1";
}

export default function PulseAgencyIntel({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  pulseTimeline = [],
  crmAgents = [],
  crmAgencies = [],
  pulseMappings = [],
  search = "",
  stats = {},
  onOpenEntity,
}) {
  /* ── Local state ─────────────────────────────────────────────────────── */
  const [agencyFilter, setAgencyFilter] = useState("all"); // all | not_in_crm | in_crm
  const [agencySort, setAgencySort] = useState({ col: "live_agent_count", dir: "desc" });
  const [agencyColFilter, setAgencyColFilter] = useState(""); // suburb text filter
  const [agencyPage, setAgencyPage] = useState(0);
  // Page size persists in localStorage so user choice survives reloads.
  const [pageSize, setPageSize] = useState(readStoredPageSize);
  const [selectedAgency, setSelectedAgency] = useState(null);
  // Auto-refresh — opt-in 60s. Agency data changes slowly.
  const [autoRefresh, setAutoRefresh] = useState(readStoredAutoRefresh);

  useEffect(() => {
    try { window.localStorage.setItem(LS_PAGE_SIZE_KEY, String(pageSize)); } catch { /* quota / SSR */ }
  }, [pageSize]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_AUTO_REFRESH_KEY, autoRefresh ? "1" : "0"); } catch { /* quota / SSR */ }
  }, [autoRefresh]);

  /* ── Build agent count map keyed by rea_agency_id or normalised name ──── */
  const agentCountMap = useMemo(() => {
    const m = {};
    for (const a of pulseAgents) {
      const key = a.agency_rea_id || normAgencyKey(a.agency_name);
      if (!key) continue;
      m[key] = (m[key] || 0) + 1;
    }
    return m;
  }, [pulseAgents]);

  /* ── Reset page on any filter/sort change (server-pagination refactor) ── */
  useEffect(() => {
    setAgencyPage(0);
  }, [agencyFilter, agencyColFilter, search, agencySort.col, agencySort.dir, pageSize]);

  /* ── Server-side query builder ──────────────────────────────────────── */
  const buildQuery = useCallback((selectCols, withCount) => {
    let q = api._supabase
      .from("pulse_agencies")
      .select(selectCols, withCount ? { count: "exact" } : undefined);

    if (agencyFilter === "in_crm") q = q.eq("is_in_crm", true);
    else if (agencyFilter === "not_in_crm") q = q.eq("is_in_crm", false);

    const sc = (agencyColFilter || "").trim();
    if (sc) {
      q = q.ilike("suburb", `%${sc.replace(/[%_]/g, "\\$&")}%`);
    }

    const globalQ = (search || "").trim();
    if (globalQ) {
      const s = globalQ.replace(/[%_]/g, "\\$&");
      q = q.or(`name.ilike.%${s}%,suburb.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
    }

    const sortCol = AGENCY_SERVER_SORT_MAP[agencySort.col] || "agent_count";
    q = q.order(sortCol, { ascending: agencySort.dir === "asc", nullsFirst: false });

    return q;
  }, [agencyFilter, agencyColFilter, search, agencySort]);

  /* ── Page fetch ─────────────────────────────────────────────────────── */
  const queryKey = useMemo(
    () => ["pulse-agencies-page", {
      agencyFilter, agencyColFilter, search,
      sortCol: agencySort.col, sortDir: agencySort.dir,
      page: agencyPage, pageSize,
    }],
    [agencyFilter, agencyColFilter, search, agencySort, agencyPage, pageSize],
  );

  const { data: pageData, isLoading, isFetching } = useQuery({
    queryKey,
    queryFn: async () => {
      const from = agencyPage * pageSize;
      const to = from + pageSize - 1;
      const q = buildQuery("*", true).range(from, to);
      const { data: rows, count, error } = await q;
      if (error) throw error;
      return { rows: rows || [], count: count || 0 };
    },
    keepPreviousData: true,
    staleTime: 30_000,
    refetchInterval: autoRefresh ? AUTO_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  /* ── Enrich ONLY the fetched page with live_agent_count ─────────────── */
  const pageRows = useMemo(() => {
    const rows = pageData?.rows || [];
    return rows.map((ag) => ({
      ...ag,
      live_agent_count:
        agentCountMap[ag.rea_agency_id || normAgencyKey(ag.name)] ||
        ag.agent_count ||
        0,
    }));
  }, [pageData, agentCountMap]);

  const totalCount = pageData?.count || 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(agencyPage, pageCount - 1);

  // For the "X of Y" display in the filter bar, show server total.
  const sorted = { length: totalCount }; // kept as object for minimal downstream churn

  const [exporting, setExporting] = useState(false);

  /* ── CSV export — fetch entire filtered set from server ──────────────── */
  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const cap = Math.min(totalCount, CSV_EXPORT_CAP_AGENCIES);
      if (totalCount > CSV_EXPORT_CAP_AGENCIES) {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
          `Filter matches ${totalCount.toLocaleString()} agencies. Only the first ${CSV_EXPORT_CAP_AGENCIES.toLocaleString()} will export. Continue?`,
        );
        if (!ok) { setExporting(false); return; }
      }
      const all = [];
      for (let off = 0; off < cap; off += 1000) {
        const end = Math.min(off + 999, cap - 1);
        const { data: chunk, error } = await buildQuery("*", false).range(off, end);
        if (error) throw error;
        all.push(...(chunk || []));
        if (!chunk || chunk.length < 1000) break;
      }
      // Enrich with live_agent_count before serialising
      const enriched = all.map((ag) => ({
        ...ag,
        live_agent_count:
          agentCountMap[ag.rea_agency_id || normAgencyKey(ag.name)] ||
          ag.agent_count ||
          0,
      }));
      const header = [
        "name", "suburb", "state", "phone", "email", "website",
        "live_agent_count", "active_listings", "total_sold_12m",
        "avg_sold_price", "avg_agent_rating", "is_in_crm",
        "rea_agency_id", "last_synced_at",
      ];
      exportCsv(`pulse_agencies_${new Date().toISOString().slice(0, 10)}.csv`, header, enriched);
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`CSV export failed: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  }, [buildQuery, totalCount, agentCountMap]);

  /* ── Sort toggle ──────────────────────────────────────────────────────── */
  function toggleSort(col) {
    setAgencySort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: "desc" }
    );
    setAgencyPage(0);
  }

  /* ── Filter change resets to page 0 ─────────────────────────────────── */
  function handleFilter(val) {
    setAgencyFilter(val);
    setAgencyPage(0);
  }

  function handleColFilter(val) {
    setAgencyColFilter(val);
    setAgencyPage(0);
  }

  /* ── Column header button ─────────────────────────────────────────────── */
  const ColHeader = ({ col, children, className }) => (
    <button
      onClick={() => toggleSort(col)}
      className={cn(
        "flex items-center gap-0.5 text-left font-medium text-muted-foreground hover:text-foreground transition-colors",
        agencySort.col === col && "text-foreground",
        className
      )}
    >
      {children}
      <SortIcon col={col} current={agencySort.col} dir={agencySort.dir} />
    </button>
  );

  /* ── Render ───────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-3">
      {/* ── Filter bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* CRM status filter */}
        <div className="flex items-center gap-1">
          {[
            { value: "all", label: "All Agencies" },
            { value: "not_in_crm", label: "Not in CRM" },
            { value: "in_crm", label: "In CRM" },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => handleFilter(value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
                agencyFilter === value
                  ? "bg-primary text-primary-foreground border-primary shadow-sm"
                  : "bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground"
              )}
            >
              {label}
              {value === "all" && ` (${pulseAgencies.length})`}
              {value === "not_in_crm" &&
                ` (${pulseAgencies.filter((a) => !a.is_in_crm).length})`}
              {value === "in_crm" &&
                ` (${pulseAgencies.filter((a) => a.is_in_crm).length})`}
            </button>
          ))}
        </div>

        {/* Suburb column filter */}
        <div className="relative flex-1 max-w-xs">
          <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Filter by suburb…"
            value={agencyColFilter}
            onChange={(e) => handleColFilter(e.target.value)}
            className="w-full pl-7 pr-3 h-7 text-xs rounded-md border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {agencyColFilter && (
            <button
              onClick={() => handleColFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* CSV export + count + auto-refresh */}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={handleExportCsv}
            disabled={totalCount === 0 || exporting}
            title="Export filtered agencies as CSV (server-side, up to 10k rows)"
          >
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            CSV
          </Button>
          {/* Auto-refresh toggle — opt-in 60s. */}
          <label
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
            title="Auto-refresh every 60s"
          >
            <Switch
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
              aria-label="Auto-refresh every 60s"
            />
            <span>Auto-refresh</span>
          </label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {isFetching ? (
              <Loader2 className="inline h-3 w-3 animate-spin" />
            ) : totalCount === 0 ? (
              <>0 agencies</>
            ) : (
              <>
                {Math.min(agencyPage * pageSize + 1, totalCount).toLocaleString()}–{Math.min((agencyPage + 1) * pageSize, totalCount).toLocaleString()} of {totalCount.toLocaleString()}
              </>
            )}
          </span>
        </div>
      </div>

      {/* ── Table card ── */}
      <Card className="rounded-xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/30">
                {/* Logo */}
                <th className="pl-3 pr-2 py-2 w-10" />
                {/* Name */}
                <th className="px-2 py-2 text-left">
                  <ColHeader col="name">Agency</ColHeader>
                </th>
                {/* Phone */}
                <th className="px-2 py-2 text-left hidden md:table-cell">
                  <ColHeader col="phone">Phone</ColHeader>
                </th>
                {/* Agents */}
                <th className="px-2 py-2 text-right">
                  <ColHeader col="live_agent_count" className="ml-auto">
                    Agents
                  </ColHeader>
                </th>
                {/* Active Listings */}
                <th className="px-2 py-2 text-right hidden sm:table-cell">
                  <ColHeader col="active_listings" className="ml-auto">
                    Active
                  </ColHeader>
                </th>
                {/* Total Sold */}
                <th className="px-2 py-2 text-right hidden lg:table-cell">
                  <ColHeader col="total_sold_12m" className="ml-auto">
                    Sold 12m
                  </ColHeader>
                </th>
                {/* Avg Price */}
                <th className="px-2 py-2 text-right hidden lg:table-cell">
                  <ColHeader col="avg_sold_price" className="ml-auto">
                    Avg $
                  </ColHeader>
                </th>
                {/* Rating */}
                <th className="px-2 py-2 text-right hidden xl:table-cell">
                  <ColHeader col="avg_agent_rating" className="ml-auto">
                    Rating
                  </ColHeader>
                </th>
                {/* Last synced */}
                <th className="px-2 py-2 text-right hidden xl:table-cell">
                  <span className="text-muted-foreground font-medium">Synced</span>
                </th>
                {/* CRM */}
                <th className="px-2 py-2 text-right pr-3">
                  <span className="text-muted-foreground font-medium">CRM</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="text-center py-12 text-muted-foreground"
                  >
                    <Loader2 className="h-6 w-6 mx-auto mb-2 text-muted-foreground/40 animate-spin" />
                    <p className="text-sm">Loading agencies…</p>
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="text-center py-12 text-muted-foreground"
                  >
                    <Building2 className="h-8 w-8 mx-auto mb-2 text-muted-foreground/20" />
                    <p className="text-sm">No agencies match your filters.</p>
                  </td>
                </tr>
              ) : (
                pageRows.map((ag, idx) => (
                  <tr
                    key={ag.id || idx}
                    onClick={() =>
                      onOpenEntity
                        ? onOpenEntity({ type: "agency", id: ag.id })
                        : setSelectedAgency(ag)
                    }
                    className="border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors"
                  >
                    {/* Logo */}
                    <td className="pl-3 pr-2 py-2 w-10">
                      <div className="h-8 w-8 rounded-lg overflow-hidden bg-muted flex items-center justify-center border">
                        {ag.logo_url ? (
                          <img
                            src={ag.logo_url}
                            alt={ag.name}
                            className="h-full w-full object-contain p-0.5"
                            onError={(e) => {
                              e.target.style.display = "none";
                            }}
                          />
                        ) : (
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground/40" />
                        )}
                      </div>
                    </td>
                    {/* Name + suburb */}
                    <td className="px-2 py-2 max-w-[180px]">
                      <p className="font-medium truncate">{ag.name || "—"}</p>
                      {ag.suburb && (
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                          <MapPin className="h-2.5 w-2.5 inline mr-0.5 -mt-px" />
                          {ag.suburb}
                          {ag.state && `, ${ag.state}`}
                        </p>
                      )}
                    </td>
                    {/* Phone */}
                    <td className="px-2 py-2 hidden md:table-cell text-muted-foreground">
                      {ag.phone ? (
                        <a
                          href={`tel:${ag.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-foreground transition-colors"
                        >
                          {ag.phone}
                        </a>
                      ) : (
                        <span className="text-muted-foreground/30">—</span>
                      )}
                    </td>
                    {/* Agents */}
                    <td className="px-2 py-2 text-right tabular-nums">
                      <span
                        className={cn(
                          "font-semibold",
                          ag.live_agent_count > 0
                            ? "text-foreground"
                            : "text-muted-foreground/30"
                        )}
                      >
                        {ag.live_agent_count > 0 ? ag.live_agent_count : "—"}
                      </span>
                    </td>
                    {/* Active listings */}
                    <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">
                      <span
                        className={cn(
                          ag.active_listings > 0
                            ? "text-emerald-600 dark:text-emerald-400 font-medium"
                            : "text-muted-foreground/30"
                        )}
                      >
                        {ag.active_listings > 0 ? ag.active_listings : "—"}
                      </span>
                    </td>
                    {/* Total sold */}
                    <td className="px-2 py-2 text-right tabular-nums hidden lg:table-cell text-muted-foreground">
                      {ag.total_sold_12m > 0 ? ag.total_sold_12m : "—"}
                    </td>
                    {/* Avg price */}
                    <td className="px-2 py-2 text-right tabular-nums hidden lg:table-cell font-medium">
                      {fmtPrice(ag.avg_sold_price)}
                    </td>
                    {/* Rating */}
                    <td className="px-2 py-2 text-right hidden xl:table-cell">
                      <span className="flex items-center justify-end gap-0.5">
                        <StarRating value={ag.avg_agent_rating} />
                      </span>
                    </td>
                    {/* Last synced */}
                    <td
                      className="px-2 py-2 text-right text-[10px] text-muted-foreground hidden xl:table-cell whitespace-nowrap"
                      title={ag.last_synced_at ? new Date(ag.last_synced_at).toLocaleString() : "Never synced"}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        <Clock className="h-2.5 w-2.5" />
                        {fmtAgo(ag.last_synced_at)}
                      </span>
                    </td>
                    {/* CRM badge */}
                    <td className="px-2 py-2 text-right pr-3">
                      <CrmBadge inCrm={!!ag.is_in_crm} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {sorted.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t bg-muted/20">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {safePage * pageSize + 1}–
                {Math.min((safePage + 1) * pageSize, sorted.length)} of{" "}
                {sorted.length.toLocaleString()}
              </span>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setAgencyPage(0); }}
                className="h-6 text-[10px] rounded border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring"
                title="Rows per page"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-6 w-6"
                disabled={safePage === 0}
                onClick={() => setAgencyPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <span className="text-[10px] text-muted-foreground tabular-nums px-1">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-6 w-6"
                disabled={safePage >= pageCount - 1}
                onClick={() => setAgencyPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Agency Slideout ── */}
      {selectedAgency && (
        <AgencySlideout
          agency={selectedAgency}
          pulseAgents={pulseAgents}
          pulseListings={pulseListings}
          pulseTimeline={pulseTimeline}
          crmAgencies={crmAgencies}
          pulseMappings={pulseMappings}
          onClose={() => setSelectedAgency(null)}
        />
      )}
    </div>
  );
}

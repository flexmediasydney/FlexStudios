/**
 * PulseAgentIntel — Agent Intelligence Tab
 *
 * Filtered / sorted / paginated agent table with:
 *   - Column filters (agency, suburb)
 *   - Global search (name, agency, email, mobile, suburb)
 *   - Click-row slideout panel (full dossier)
 *   - Add-to-CRM two-step flow with dedup check
 *
 * Architecture: REA-only. Single ID: rea_agent_id. Zero Domain references.
 */

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Users,
  Star,
  ExternalLink,
  Phone,
  Mail,
  MapPin,
  Award,
  UserPlus,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Building2,
  Globe,
  Hash,
  Briefcase,
  ChevronUp,
  ChevronDown,
  X,
} from "lucide-react";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-AU", {
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

function normalize(s) {
  return (s || "").replace(/\D/g, "").trim().toLowerCase();
}

function fuzzyNameMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Check if first+last words overlap (handles "John Smith" vs "John A. Smith")
  const wa = na.split(" ");
  const wb = nb.split(" ");
  return wa[0] === wb[0] && wa[wa.length - 1] === wb[wb.length - 1];
}

function mapPosition(jobTitle) {
  const jt = (jobTitle || "").toLowerCase();
  if (
    jt.includes("partner") ||
    jt.includes("director") ||
    jt.includes("managing") ||
    jt.includes("principal") ||
    jt.includes("licensee") ||
    jt.includes("owner") ||
    jt.includes("ceo")
  )
    return "Partner";
  if (jt.includes("senior") || jt.includes("manager") || jt.includes("head of"))
    return "Senior";
  if (jt.includes("associate")) return "Associate";
  return "Junior";
}

function PositionBadge({ position }) {
  const cls =
    position === "Partner"
      ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
      : position === "Senior"
      ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800"
      : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-medium leading-4",
        cls
      )}
    >
      {position}
    </span>
  );
}

function CrmStatusBadge({ inCrm }) {
  return inCrm ? (
    <span className="inline-flex items-center rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800 px-1.5 py-0 text-[9px] font-medium leading-4">
      In CRM
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800 px-1.5 py-0 text-[9px] font-medium leading-4">
      Prospect
    </span>
  );
}

function ReaBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800 px-1.5 py-0 text-[9px] font-semibold leading-4">
      REA
    </span>
  );
}

function AgentAvatar({ agent, size = 32 }) {
  const initials = (agent.full_name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (agent.profile_image) {
    return (
      <img
        src={agent.profile_image}
        alt={agent.full_name}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
        onError={(e) => {
          e.target.style.display = "none";
          e.target.nextSibling && (e.target.nextSibling.style.display = "flex");
        }}
      />
    );
  }

  return (
    <div
      className="rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-muted-foreground font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.35 }}
    >
      {initials}
    </div>
  );
}

function StarRating({ rating, count }) {
  if (!rating) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs">
      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
      <span className="tabular-nums font-medium">{Number(rating).toFixed(1)}</span>
      {count > 0 && (
        <span className="text-muted-foreground text-[10px]">({count})</span>
      )}
    </span>
  );
}

/* ── Sort indicator ──────────────────────────────────────────────────────── */

function SortIcon({ col, sort }) {
  if (sort.col !== col)
    return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40 ml-0.5 inline" />;
  return sort.dir === "asc" ? (
    <ChevronUp className="h-3 w-3 text-primary ml-0.5 inline" />
  ) : (
    <ChevronDown className="h-3 w-3 text-primary ml-0.5 inline" />
  );
}

/* ── Mini listing table (inside slideout) ────────────────────────────────── */

function MiniListingTable({ listings, emptyMsg }) {
  if (!listings.length)
    return <p className="text-xs text-muted-foreground py-2">{emptyMsg}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Address</th>
            <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Price</th>
            <th className="text-right py-1.5 font-medium text-muted-foreground">DOM</th>
          </tr>
        </thead>
        <tbody>
          {listings.slice(0, 10).map((l) => (
            <tr key={l.id} className="border-b border-border/40 hover:bg-muted/40">
              <td className="py-1.5 pr-3 max-w-[220px] truncate text-foreground">
                {l.address || l.suburb || "—"}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtPrice(l.asking_price || l.sold_price)}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {l.days_on_market > 0 ? `${l.days_on_market}d` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {listings.length > 10 && (
        <p className="text-[10px] text-muted-foreground pt-1">
          + {listings.length - 10} more
        </p>
      )}
    </div>
  );
}

/* ── Add to CRM Flow ─────────────────────────────────────────────────────── */

function AddToCrmDialog({ agent, crmAgents, crmAgencies, pulseMappings, onClose, onSuccess }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [agencyChoice, setAgencyChoice] = useState("create"); // "create" | existing agency id

  const existingByName = useMemo(
    () => crmAgents.filter((c) => fuzzyNameMatch(c.name, agent.full_name)),
    [crmAgents, agent.full_name]
  );

  const existingByPhone = useMemo(() => {
    const mob = normalize(agent.mobile);
    if (!mob) return [];
    return crmAgents.filter((c) => normalize(c.phone) === mob || normalize(c.mobile) === mob);
  }, [crmAgents, agent.mobile]);

  const existingAgency = useMemo(
    () =>
      crmAgencies.find(
        (c) => normAgencyKey(c.name) === normAgencyKey(agent.agency_name)
      ),
    [crmAgencies, agent.agency_name]
  );

  const hasDuplicate = existingByName.length > 0 || existingByPhone.length > 0;

  async function handleConfirm() {
    setSaving(true);
    try {
      // 1. Create or find agency
      let agencyId = existingAgency?.id;
      if (!agencyId && agent.agency_name) {
        const newAgency = await api.entities.Agency.create({
          name: agent.agency_name,
          rea_agency_id: agent.agency_rea_id,
        });
        agencyId = newAgency.id;
        await refetchEntityList("Agency");
      }

      // 2. Create CRM agent
      const newAgent = await api.entities.Agent.create({
        name: agent.full_name,
        phone: agent.mobile || agent.business_phone,
        email: agent.email,
        current_agency_id: agencyId,
        rea_agent_id: agent.rea_agent_id,
        title: agent.job_title,
        relationship_state: "prospect",
        source: "pulse",
      });

      // 3. Create mapping
      await api.entities.PulseCrmMapping.create({
        entity_type: "agent",
        pulse_entity_id: agent.id,
        crm_entity_id: newAgent.id,
        rea_id: agent.rea_agent_id,
        match_type: "manual",
        confidence: "confirmed",
      });

      // 4. Mark pulse agent as in_crm
      await api.entities.PulseAgent.update(agent.id, { is_in_crm: true });

      await refetchEntityList("PulseAgent");
      await refetchEntityList("PulseCrmMapping");

      toast.success(`${agent.full_name} added to CRM`);
      onSuccess();
    } catch (err) {
      console.error("Add to CRM failed:", err);
      toast.error("Failed to add agent to CRM. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" />
            Add to CRM
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4 py-2">
            {/* Agent preview */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border border-border">
              <AgentAvatar agent={agent} size={40} />
              <div className="min-w-0">
                <p className="font-semibold text-sm leading-tight">{agent.full_name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {agent.agency_name}
                  {agent.suburb ? ` · ${agent.suburb}` : ""}
                </p>
                {agent.mobile && (
                  <p className="text-xs text-muted-foreground">{agent.mobile}</p>
                )}
              </div>
            </div>

            {/* Dedup warnings */}
            {hasDuplicate && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 space-y-2">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1">
                  <Award className="h-3.5 w-3.5" />
                  Possible duplicates found
                </p>
                {existingByName.map((c) => (
                  <p key={c.id} className="text-xs text-amber-700 dark:text-amber-300 pl-5">
                    Name match: <strong>{c.name}</strong>
                    {c.phone ? ` · ${c.phone}` : ""}
                  </p>
                ))}
                {existingByPhone
                  .filter((c) => !existingByName.find((n) => n.id === c.id))
                  .map((c) => (
                    <p key={c.id} className="text-xs text-amber-700 dark:text-amber-300 pl-5">
                      Phone match: <strong>{c.name}</strong> · {c.phone}
                    </p>
                  ))}
                <p className="text-[10px] text-amber-600 dark:text-amber-400 pl-5">
                  You can still proceed — this will create a new CRM record.
                </p>
              </div>
            )}

            {/* Agency status */}
            <div className="rounded-lg border border-border p-3 space-y-1">
              <p className="text-xs font-medium text-foreground">Agency</p>
              {existingAgency ? (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  Will link to existing: <strong className="ml-1">{existingAgency.name}</strong>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  Will create new agency:{" "}
                  <strong className="ml-1">{agent.agency_name || "Unknown"}</strong>
                </p>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground">
              This will create a CRM Agent record and a Pulse mapping. The agent's
              REA ID will be stored for future intelligence syncing.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border border-border">
              <AgentAvatar agent={agent} size={40} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm leading-tight">{agent.full_name}</p>
                <p className="text-xs text-muted-foreground">{agent.agency_name}</p>
              </div>
              <ReaBadge />
            </div>

            <div className="rounded-lg border border-border divide-y divide-border text-xs">
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">REA Agent ID</span>
                <span className="font-mono text-[10px]">{agent.rea_agent_id || "—"}</span>
              </div>
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">Mobile</span>
                <span>{agent.mobile || "—"}</span>
              </div>
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">Email</span>
                <span className="truncate max-w-[200px]">{agent.email || "—"}</span>
              </div>
              <div className="px-3 py-2 flex justify-between">
                <span className="text-muted-foreground">Agency</span>
                <span>{existingAgency ? "Link existing" : "Create new"}</span>
              </div>
            </div>

            <p className="text-xs font-semibold text-foreground">Confirm creation?</p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {step === 1 && (
            <Button size="sm" onClick={() => setStep(2)}>
              Continue
            </Button>
          )}
          {step === 2 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep(1)}
                disabled={saving}
              >
                Back
              </Button>
              <Button size="sm" onClick={handleConfirm} disabled={saving}>
                {saving ? "Creating…" : "Confirm & Add"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Agent Slideout ──────────────────────────────────────────────────────── */

function AgentSlideout({ agent, pulseListings, crmAgents, crmAgencies, pulseMappings, onClose, onAddToCrm }) {
  const position = mapPosition(agent.job_title);

  const agentListings = useMemo(() => {
    const id = agent.rea_agent_id;
    if (!id) return { active: [], sold: [] };
    const all = pulseListings.filter(
      (l) =>
        l.agent_rea_id === id ||
        (Array.isArray(l.agent_rea_ids) && l.agent_rea_ids.includes(id))
    );
    return {
      active: all.filter(
        (l) => l.listing_type === "for_sale" || l.listing_type === "for_rent"
      ),
      sold: all.filter((l) => l.listing_type === "sold"),
    };
  }, [agent.rea_agent_id, pulseListings]);

  const suburbs = useMemo(() => {
    try {
      const raw = agent.suburbs_active;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") return JSON.parse(raw);
      return [];
    } catch {
      return [];
    }
  }, [agent.suburbs_active]);

  const socials = useMemo(() => {
    try {
      const raw = agent.social_links;
      if (!raw) return {};
      if (typeof raw === "object" && !Array.isArray(raw)) return raw;
      if (typeof raw === "string") return JSON.parse(raw);
      return {};
    } catch {
      return {};
    }
  }, [agent.social_links]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {/* ── Header ── */}
        <div className="sticky top-0 z-10 bg-background border-b border-border px-5 pt-5 pb-4">
          <div className="flex items-start gap-4">
            <AgentAvatar agent={agent} size={56} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                <h2 className="text-base font-bold leading-tight">{agent.full_name}</h2>
                <PositionBadge position={position} />
                <ReaBadge />
                <CrmStatusBadge inCrm={agent.is_in_crm} />
              </div>
              {agent.job_title && (
                <p className="text-xs text-muted-foreground">{agent.job_title}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* ── Contact ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Contact
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              {agent.mobile && (
                <a
                  href={`tel:${agent.mobile}`}
                  className="flex items-center gap-2 text-foreground hover:text-primary transition-colors"
                >
                  <Phone className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{agent.mobile}</span>
                </a>
              )}
              {agent.business_phone && agent.business_phone !== agent.mobile && (
                <a
                  href={`tel:${agent.business_phone}`}
                  className="flex items-center gap-2 text-foreground hover:text-primary transition-colors"
                >
                  <Briefcase className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{agent.business_phone}</span>
                </a>
              )}
              {agent.email && (
                <a
                  href={`mailto:${agent.email}`}
                  className="flex items-center gap-2 text-foreground hover:text-primary transition-colors sm:col-span-2"
                >
                  <Mail className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{agent.email}</span>
                </a>
              )}
              {!agent.mobile && !agent.email && (
                <p className="text-xs text-muted-foreground">No contact info enriched yet</p>
              )}
            </div>
          </section>

          {/* ── Agency ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Agency
            </h3>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <span className="font-medium">{agent.agency_name || "—"}</span>
              </div>
              {agent.suburb && (
                <div className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-muted-foreground">{agent.suburb}</span>
                </div>
              )}
              {agent.agency_id && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Hash className="h-3 w-3" />
                  <span className="font-mono">{agent.agency_id}</span>
                </div>
              )}
            </div>
          </section>

          {/* ── Stats ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Performance
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border p-3 text-center">
                <p className="text-lg font-bold tabular-nums text-foreground">
                  {agent.sales_as_lead ?? "—"}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Sales as Lead</p>
              </div>
              <div className="rounded-lg border border-border p-3 text-center">
                <p className="text-lg font-bold tabular-nums text-foreground">
                  {fmtPrice(agent.median_sold_price || agent.avg_sold_price)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Median Sold</p>
              </div>
              <div className="rounded-lg border border-border p-3 text-center">
                <p className="text-lg font-bold tabular-nums text-foreground">
                  {agent.avg_days_on_market > 0 ? `${agent.avg_days_on_market}d` : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Avg DOM</p>
              </div>
            </div>
          </section>

          {/* ── Reviews ── */}
          {(agent.rea_rating || agent.rea_review_count > 0) && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Reviews
              </h3>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star
                      key={s}
                      className={cn(
                        "h-4 w-4",
                        s <= Math.round(agent.rea_rating || 0)
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/30"
                      )}
                    />
                  ))}
                </div>
                <span className="text-sm font-semibold">
                  {agent.rea_rating ? Number(agent.rea_rating).toFixed(1) : "—"}
                </span>
                {agent.rea_review_count > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {agent.rea_review_count} review{agent.rea_review_count !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </section>
          )}

          {/* ── Awards ── */}
          {agent.awards && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Awards
              </h3>
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 flex items-start gap-2">
                <Award className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-300">{agent.awards}</p>
              </div>
            </section>
          )}

          {/* ── Specialty suburbs ── */}
          {suburbs.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Active Suburbs
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {suburbs.map((sub) => (
                  <Badge
                    key={sub}
                    variant="secondary"
                    className="text-[10px] px-2 py-0.5 font-normal"
                  >
                    {sub}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          {/* ── Social / Profile links ── */}
          {(socials.facebook || socials.instagram || socials.linkedin || agent.rea_profile_url) && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Links
              </h3>
              <div className="flex flex-wrap gap-2">
                {agent.rea_profile_url && (
                  <a
                    href={agent.rea_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    REA Profile
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {socials.facebook && (
                  <a
                    href={socials.facebook}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    Facebook
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {socials.instagram && (
                  <a
                    href={socials.instagram}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-pink-600 dark:text-pink-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    Instagram
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {socials.linkedin && (
                  <a
                    href={socials.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400 hover:underline"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    LinkedIn
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </section>
          )}

          {/* ── Active Listings ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Active Listings ({agentListings.active.length})
            </h3>
            <MiniListingTable
              listings={agentListings.active}
              emptyMsg="No active listings found"
            />
          </section>

          {/* ── Recently Sold ── */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Recently Sold ({agentListings.sold.length})
            </h3>
            <MiniListingTable
              listings={agentListings.sold}
              emptyMsg="No sold listings found"
            />
          </section>
        </div>

        {/* ── Footer ── */}
        <div className="sticky bottom-0 bg-background border-t border-border px-5 py-3 flex items-center justify-between gap-3">
          {!agent.is_in_crm && (
            <Button size="sm" onClick={() => onAddToCrm(agent)} className="gap-1.5">
              <UserPlus className="h-3.5 w-3.5" />
              Add to CRM
            </Button>
          )}
          {agent.rea_profile_url && (
            <a
              href={agent.rea_profile_url}
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
          {!agent.rea_profile_url && agent.is_in_crm && (
            <span className="text-xs text-muted-foreground ml-auto">Already in CRM</span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Main Component ──────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

const SORT_COLS = {
  sales_as_lead: (a) => a.sales_as_lead ?? -1,
  total_listings_active: (a) => a.total_listings_active ?? -1,
  avg_sold_price: (a) => a.avg_sold_price ?? -1,
  rea_rating: (a) => a.rea_rating ?? -1,
  name: (a) => (a.full_name || "").toLowerCase(),
  agency: (a) => (a.agency_name || "").toLowerCase(),
  suburb: (a) => (a.suburb || "").toLowerCase(),
};

export default function PulseAgentIntel({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  crmAgents = [],
  crmAgencies = [],
  pulseMappings = [],
  search = "",
  stats = {},
  addToCrmFromCommand,
}) {
  // ── UI state ──────────────────────────────────────────────────────────────
  const [agentFilter, setAgentFilter] = useState("all"); // all | not_in_crm | in_crm
  const [agentSort, setAgentSort] = useState({ col: "sales_as_lead", dir: "desc" });
  const [agentColFilters, setAgentColFilters] = useState({ agency: "", suburb: "" });
  const [agentPage, setAgentPage] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [addToCrmCandidate, setAddToCrmCandidate] = useState(null);

  // ── Auto-open Add-to-CRM dialog when triggered from CommandCenter ───────
  useEffect(() => {
    if (addToCrmFromCommand) {
      const agent = pulseAgents.find((a) => a.id === addToCrmFromCommand.id);
      if (agent) {
        setAddToCrmCandidate(agent);
      }
    }
  }, [addToCrmFromCommand, pulseAgents]);

  // ── Toggle sort ───────────────────────────────────────────────────────────
  const toggleSort = useCallback(
    (col) => {
      setAgentSort((prev) =>
        prev.col === col
          ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { col, dir: "desc" }
      );
      setAgentPage(0);
    },
    []
  );

  // ── Filtered + sorted + paginated agents ─────────────────────────────────
  const { filtered, paginated, totalPages, totalCount } = useMemo(() => {
    const q = (search || "").toLowerCase().trim();
    const agencyQ = agentColFilters.agency.toLowerCase().trim();
    const suburbQ = agentColFilters.suburb.toLowerCase().trim();

    let list = pulseAgents;

    // Status filter
    if (agentFilter === "not_in_crm") list = list.filter((a) => !a.is_in_crm);
    else if (agentFilter === "in_crm") list = list.filter((a) => a.is_in_crm);

    // Column filters
    if (agencyQ) {
      list = list.filter((a) =>
        (a.agency_name || "").toLowerCase().includes(agencyQ)
      );
    }
    if (suburbQ) {
      list = list.filter((a) =>
        (a.suburb || "").toLowerCase().includes(suburbQ)
      );
    }

    // Global search
    if (q) {
      list = list.filter((a) => {
        const haystack = [
          a.full_name,
          a.agency_name,
          a.email,
          a.mobile,
          a.suburb,
          a.job_title,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    // Sort
    const accessor = SORT_COLS[agentSort.col] || SORT_COLS.sales_as_lead;
    const dir = agentSort.dir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      const va = accessor(a);
      const vb = accessor(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });

    const totalCount = list.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const safePageIndex = Math.min(agentPage, totalPages - 1);
    const paginated = list.slice(safePageIndex * PAGE_SIZE, (safePageIndex + 1) * PAGE_SIZE);

    return { filtered: list, paginated, totalPages, totalCount };
  }, [pulseAgents, agentFilter, agentColFilters, search, agentSort, agentPage]);

  const safePage = Math.min(agentPage, totalPages - 1);
  const showingStart = safePage * PAGE_SIZE + 1;
  const showingEnd = Math.min(showingStart + PAGE_SIZE - 1, totalCount);

  function handleColFilterChange(col, val) {
    setAgentColFilters((prev) => ({ ...prev, [col]: val }));
    setAgentPage(0);
  }

  function handleFilterChange(f) {
    setAgentFilter(f);
    setAgentPage(0);
  }

  /* ── Render ── */
  return (
    <div className="space-y-3">
      {/* ── Filter bar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {[
          { key: "all", label: "All Agents", count: pulseAgents.length },
          {
            key: "not_in_crm",
            label: "Not in CRM",
            count: stats.notInCrm ?? pulseAgents.filter((a) => !a.is_in_crm).length,
          },
          {
            key: "in_crm",
            label: "In CRM",
            count: pulseAgents.filter((a) => a.is_in_crm).length,
          },
        ].map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => handleFilterChange(key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              agentFilter === key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
            )}
          >
            {label}
            <span
              className={cn(
                "tabular-nums rounded-full px-1.5 py-0 text-[9px] font-semibold",
                agentFilter === key
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {count.toLocaleString()}
            </span>
          </button>
        ))}

        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {totalCount > 0
            ? `Showing ${showingStart.toLocaleString()}–${showingEnd.toLocaleString()} of ${totalCount.toLocaleString()}`
            : "No results"}
        </div>
      </div>

      {/* ── Table card ── */}
      <Card className="rounded-xl border-0 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            {/* ── thead ── */}
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {/* Photo */}
                <th className="py-2.5 pl-3 pr-2 w-10" />
                {/* Name */}
                <th
                  className="py-2.5 px-2 text-left font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("name")}
                >
                  Agent <SortIcon col="name" sort={agentSort} />
                </th>
                {/* Agency */}
                <th
                  className="py-2.5 px-2 text-left font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("agency")}
                >
                  Agency <SortIcon col="agency" sort={agentSort} />
                </th>
                {/* Email */}
                <th className="py-2.5 px-2 text-left font-medium text-muted-foreground hidden lg:table-cell whitespace-nowrap">
                  Email
                </th>
                {/* Mobile */}
                <th className="py-2.5 px-2 text-left font-medium text-muted-foreground hidden md:table-cell whitespace-nowrap">
                  Mobile
                </th>
                {/* Listings */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("total_listings_active")}
                >
                  Listings <SortIcon col="total_listings_active" sort={agentSort} />
                </th>
                {/* Sales */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground whitespace-nowrap"
                  onClick={() => toggleSort("sales_as_lead")}
                >
                  Sales <SortIcon col="sales_as_lead" sort={agentSort} />
                </th>
                {/* Avg Price */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground hidden sm:table-cell whitespace-nowrap"
                  onClick={() => toggleSort("avg_sold_price")}
                >
                  Avg Price <SortIcon col="avg_sold_price" sort={agentSort} />
                </th>
                {/* Rating */}
                <th
                  className="py-2.5 px-2 text-right font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground hidden sm:table-cell whitespace-nowrap"
                  onClick={() => toggleSort("rea_rating")}
                >
                  Rating <SortIcon col="rea_rating" sort={agentSort} />
                </th>
                {/* CRM */}
                <th className="py-2.5 px-3 text-right font-medium text-muted-foreground whitespace-nowrap">
                  CRM
                </th>
              </tr>

              {/* ── Column filter row ── */}
              <tr className="border-b border-border bg-muted/20">
                <td colSpan={2} className="py-1 pl-3 pr-2">
                  {/* empty — agent col has no filter */}
                </td>
                {/* Agency filter */}
                <td className="py-1 px-2">
                  <input
                    type="text"
                    placeholder="Filter agency…"
                    value={agentColFilters.agency}
                    onChange={(e) => handleColFilterChange("agency", e.target.value)}
                    className="w-full min-w-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </td>
                {/* Email — no filter */}
                <td className="py-1 px-2 hidden lg:table-cell" />
                {/* Mobile — no filter */}
                <td className="py-1 px-2 hidden md:table-cell" />
                {/* Listings — no filter */}
                <td className="py-1 px-2" />
                {/* Sales — no filter */}
                <td className="py-1 px-2" />
                {/* Avg Price — no filter */}
                <td className="py-1 px-2 hidden sm:table-cell" />
                {/* Rating — no filter */}
                <td className="py-1 px-2 hidden sm:table-cell" />
                {/* Suburb filter (lives in CRM column for space, but targets suburb) */}
                <td className="py-1 px-3">
                  <input
                    type="text"
                    placeholder="Suburb…"
                    value={agentColFilters.suburb}
                    onChange={(e) => handleColFilterChange("suburb", e.target.value)}
                    className="w-full min-w-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </td>
              </tr>
            </thead>

            {/* ── tbody ── */}
            <tbody>
              {paginated.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                    No agents match your filters
                  </td>
                </tr>
              )}

              {paginated.map((agent) => {
                const position = mapPosition(agent.job_title);
                return (
                  <tr
                    key={agent.id}
                    className="border-b border-border/60 hover:bg-muted/40 cursor-pointer transition-colors"
                    onClick={() => setSelectedAgent(agent)}
                  >
                    {/* Photo */}
                    <td className="py-2 pl-3 pr-2">
                      <AgentAvatar agent={agent} size={32} />
                    </td>

                    {/* Name + badges */}
                    <td className="py-2 px-2">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="font-medium text-foreground truncate max-w-[160px]">
                          {agent.full_name || "—"}
                        </span>
                        <div className="flex items-center gap-1 flex-wrap">
                          <PositionBadge position={position} />
                          {agent.rea_agent_id && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground font-mono">
                              <Hash className="h-2.5 w-2.5" />
                              {String(agent.rea_agent_id).slice(0, 8)}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Agency + suburb */}
                    <td className="py-2 px-2">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-foreground truncate max-w-[160px]">
                          {agent.agency_name || "—"}
                        </span>
                        {agent.suburb && (
                          <span className="text-[10px] text-muted-foreground truncate max-w-[160px]">
                            {agent.suburb}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Email */}
                    <td className="py-2 px-2 hidden lg:table-cell">
                      {agent.email ? (
                        <a
                          href={`mailto:${agent.email}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-primary hover:underline truncate max-w-[180px] block"
                        >
                          {agent.email}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Mobile */}
                    <td className="py-2 px-2 hidden md:table-cell">
                      {agent.mobile ? (
                        <a
                          href={`tel:${agent.mobile}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-foreground hover:text-primary transition-colors whitespace-nowrap"
                        >
                          {agent.mobile}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Listings */}
                    <td className="py-2 px-2 text-right tabular-nums">
                      <span className="font-medium">
                        {agent.total_listings_active ?? "—"}
                      </span>
                    </td>

                    {/* Sales */}
                    <td className="py-2 px-2 text-right tabular-nums">
                      <span className="font-medium">
                        {agent.sales_as_lead ?? "—"}
                      </span>
                    </td>

                    {/* Avg Price */}
                    <td className="py-2 px-2 text-right tabular-nums hidden sm:table-cell">
                      {fmtPrice(agent.avg_sold_price)}
                    </td>

                    {/* Rating */}
                    <td className="py-2 px-2 text-right hidden sm:table-cell">
                      <StarRating rating={agent.rea_rating} count={agent.rea_review_count} />
                    </td>

                    {/* CRM status */}
                    <td className="py-2 px-3 text-right">
                      <CrmStatusBadge inCrm={agent.is_in_crm} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        {totalCount > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20">
            <span className="text-xs text-muted-foreground">
              Page {safePage + 1} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage === 0}
                onClick={() => setAgentPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage >= totalPages - 1}
                onClick={() => setAgentPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Agent slideout ── */}
      {selectedAgent && (
        <AgentSlideout
          agent={selectedAgent}
          pulseListings={pulseListings}
          crmAgents={crmAgents}
          crmAgencies={crmAgencies}
          pulseMappings={pulseMappings}
          onClose={() => setSelectedAgent(null)}
          onAddToCrm={(agent) => {
            setSelectedAgent(null);
            setAddToCrmCandidate(agent);
          }}
        />
      )}

      {/* ── Add to CRM dialog ── */}
      {addToCrmCandidate && (
        <AddToCrmDialog
          agent={addToCrmCandidate}
          crmAgents={crmAgents}
          crmAgencies={crmAgencies}
          pulseMappings={pulseMappings}
          onClose={() => setAddToCrmCandidate(null)}
          onSuccess={() => setAddToCrmCandidate(null)}
        />
      )}
    </div>
  );
}

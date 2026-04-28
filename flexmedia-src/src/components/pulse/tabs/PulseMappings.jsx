/**
 * PulseMappings — Industry Pulse "Mappings" tab.
 * Shows pulse_crm_mappings with confirm/reject actions.
 */
import React, { useState, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createPageUrl } from "@/utils";
import { api, supabase } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { CheckCircle2, XCircle, Link2, Users, Building2, ExternalLink, Search, X, Sparkles, Loader2, AlertTriangle, RefreshCw, ChevronRight } from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function ConfidenceBadge({ confidence }) {
  if (confidence === "confirmed")
    return (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px] px-1.5 py-0">
        Confirmed
      </Badge>
    );
  if (confidence === "suggested")
    return (
      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1.5 py-0">
        Suggested
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
      {confidence || "—"}
    </Badge>
  );
}

// Friendlier labels for the opaque match_type codes stored by pulseDataSync.
// See supabase/functions/pulseDataSync/index.ts — values can include "rea_id",
// "rea_id+name", "name_exact", "name_fuzzy", "phone", "phone+name", "manual".
const MATCH_TYPE_LABELS = {
  "rea_id+name": "Exact REA ID + name match",
  "rea_id": "REA ID match (no name confirmation)",
  "name_exact": "Exact name match",
  "name_fuzzy": "Fuzzy name match",
  "phone+name": "Phone + name match",
  "phone": "Phone number match",
  "manual": "Manual",
};

// Tone per match type — reflects confidence of the match strategy.
const MATCH_TYPE_TONE = {
  "rea_id+name": "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400",
  "rea_id": "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400",
  "name_exact": "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400",
  "phone+name": "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400",
  "name_fuzzy": "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400",
  "phone": "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400",
  "manual": "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400",
};

function MatchTypeBadge({ matchType }) {
  if (!matchType) {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
        —
      </Badge>
    );
  }
  const label = MATCH_TYPE_LABELS[matchType] || matchType;
  const tone = MATCH_TYPE_TONE[matchType] || "";
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] px-1.5 py-0 font-normal", tone)}
      title={`match_type=${matchType}`}
    >
      {label}
    </Badge>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const FILTER_OPTIONS = [
  { value: "all",       label: "All" },
  { value: "confirmed", label: "Confirmed" },
  { value: "suggested", label: "Suggested" },
];

const TYPE_OPTIONS = [
  { value: "all",    label: "All types" },
  { value: "agent",  label: "Agents" },
  { value: "agency", label: "Agencies" },
];

// ── Row ───────────────────────────────────────────────────────────────────────

function MappingRow({ mapping, pulseName, crmName, onConfirm, onReject, confirming, rejecting, selected, onToggleSelect }) {
  return (
    <tr className="border-b last:border-0 hover:bg-muted/30 transition-colors align-top">
      {/* QoL #63: row selection checkbox */}
      <td className="py-2.5 pl-4 pr-2 w-[32px]">
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect(mapping.id)}
          className="h-3.5 w-3.5"
          aria-label={`Select mapping ${mapping.id}`}
        />
      </td>
      {/* Entity type */}
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-1.5">
          {mapping.entity_type === "agency" ? (
            <Building2 className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          ) : (
            <Users className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          )}
          <span className="text-xs capitalize">{mapping.entity_type}</span>
        </div>
      </td>

      {/* Pulse entity — Tier 3: clickable. URL-driven entity opening in
           IndustryPulse (?tab=&pulse_id=) drives the right slideout. */}
      <td className="py-2.5 pr-3 max-w-[180px]">
        {pulseName && mapping.pulse_entity_id ? (
          <Link
            to={`/IndustryPulse?tab=${mapping.entity_type === "agency" ? "agencies" : "agents"}&pulse_id=${mapping.pulse_entity_id}&entity_type=${mapping.entity_type}`}
            replace={false}
            className="text-xs font-medium truncate text-primary hover:underline flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
            title="Open Pulse record"
          >
            {pulseName}
            <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
          </Link>
        ) : (
          <p className="text-xs font-medium truncate">
            {pulseName || <span className="text-muted-foreground italic">—</span>}
          </p>
        )}
        {mapping.rea_id && (
          <p className="text-[10px] text-muted-foreground truncate">ID: {mapping.rea_id}</p>
        )}
      </td>

      {/* CRM entity */}
      <td className="py-2.5 pr-3 max-w-[180px]">
        {crmName && mapping.crm_entity_id ? (
          <Link
            to={mapping.entity_type === "agency"
              ? createPageUrl("OrgDetails") + `?id=${mapping.crm_entity_id}`
              : createPageUrl("PersonDetails") + `?id=${mapping.crm_entity_id}`}
            replace={false}
            className="text-xs font-medium truncate text-primary hover:underline flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {crmName}
            <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
          </Link>
        ) : (
          <p className="text-xs font-medium truncate">
            {crmName || <span className="text-muted-foreground italic">—</span>}
          </p>
        )}
      </td>

      {/* Match type */}
      <td className="py-2.5 pr-3">
        <MatchTypeBadge matchType={mapping.match_type} />
      </td>

      {/* Confidence */}
      <td className="py-2.5 pr-3">
        <ConfidenceBadge confidence={mapping.confidence} />
      </td>

      {/* Created at */}
      <td className="py-2.5 pr-3 text-[10px] text-muted-foreground whitespace-nowrap">
        {fmtDate(mapping.created_at)}
      </td>

      {/* Actions */}
      <td className="py-2.5">
        <div className="flex items-center gap-1">
          {mapping.confidence !== "confirmed" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
              onClick={() => onConfirm(mapping)}
              disabled={confirming === mapping.id || rejecting === mapping.id}
              title="Confirm mapping"
            >
              {confirming === mapping.id ? (
                <span className="animate-spin text-[10px]">⟳</span>
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            onClick={() => onReject(mapping)}
            disabled={confirming === mapping.id || rejecting === mapping.id}
            title="Reject mapping"
          >
            {rejecting === mapping.id ? (
              <span className="animate-spin text-[10px]">⟳</span>
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PulseMappings({
  pulseAgents = [],
  pulseAgencies = [],
  pulseMappings = [],
  crmAgents = [],
  crmAgencies = [],
}) {
  const [filterConfidence, setFilterConfidence] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [rejectCandidate, setRejectCandidate] = useState(null);
  // QoL #63: bulk-selection + bulk-busy state.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // QoL #64: auto-confirm exact-match dialog state.
  const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);
  const [autoConfirmBusy, setAutoConfirmBusy] = useState(false);

  // BUG FIX (2026-04-19): since the IndustryPulse refactor (ed1ddce) dropped
  // the top-level `useEntityList("PulseAgent"/"PulseAgency")` fetches, the
  // props `pulseAgents` / `pulseAgencies` arrive as empty arrays. Without
  // those lookup lists the rows below render just the raw `rea_id` with no
  // name.
  //
  // BUG FIX (2026-04-28): the previous fix did a bulk `.limit(25000)` fetch
  // of the whole pulse_agents/agencies tables, but PostgREST applies a
  // server-side `max-rows` cap regardless of the requested limit. With ~9.6k
  // pulse_agents in prod, only a slice came back and rows whose pulse_agent
  // landed outside that slice rendered as "—" (e.g. jayden kiet, mitchell
  // crawford, bill kordos all had valid mappings but no name). Now we fetch
  // ONLY the pulse_agents/agencies actually referenced by `pulseMappings`
  // (~16 agents in prod today), via a targeted `.in()` lookup. Constant
  // payload, no cap to hit.
  const { mappedPulseAgentIds, mappedPulseAgentReaIds } = useMemo(() => {
    const ids = new Set();
    const reaIds = new Set();
    for (const m of pulseMappings) {
      if (m.entity_type !== "agent") continue;
      if (m.pulse_entity_id) ids.add(m.pulse_entity_id);
      if (m.rea_id) reaIds.add(m.rea_id);
    }
    return {
      mappedPulseAgentIds: [...ids],
      mappedPulseAgentReaIds: [...reaIds],
    };
  }, [pulseMappings]);

  const { mappedPulseAgencyIds, mappedPulseAgencyReaIds } = useMemo(() => {
    const ids = new Set();
    const reaIds = new Set();
    for (const m of pulseMappings) {
      if (m.entity_type !== "agency") continue;
      if (m.pulse_entity_id) ids.add(m.pulse_entity_id);
      if (m.rea_id) reaIds.add(m.rea_id);
    }
    return {
      mappedPulseAgencyIds: [...ids],
      mappedPulseAgencyReaIds: [...reaIds],
    };
  }, [pulseMappings]);

  const { data: pulseAgentLookup = [] } = useQuery({
    queryKey: [
      "pulse-mappings-agent-lookup",
      mappedPulseAgentIds,
      mappedPulseAgentReaIds,
    ],
    queryFn: async () => {
      if (mappedPulseAgentIds.length === 0 && mappedPulseAgentReaIds.length === 0) {
        return [];
      }
      // Build an OR filter so we resolve mappings that store only `rea_id`
      // (legacy) as well as those with a UUID `pulse_entity_id`.
      const filters = [];
      if (mappedPulseAgentIds.length > 0) {
        filters.push(`id.in.(${mappedPulseAgentIds.join(",")})`);
      }
      if (mappedPulseAgentReaIds.length > 0) {
        // rea_agent_id is text — quote each value to be safe.
        const quoted = mappedPulseAgentReaIds.map((v) => `"${v}"`).join(",");
        filters.push(`rea_agent_id.in.(${quoted})`);
      }
      const { data, error } = await supabase
        .from("pulse_agents")
        .select("id, full_name, rea_agent_id")
        .or(filters.join(","));
      if (error) throw error;
      return data || [];
    },
    staleTime: 5 * 60 * 1000,
    enabled:
      pulseAgents.length === 0 &&
      (mappedPulseAgentIds.length > 0 || mappedPulseAgentReaIds.length > 0),
  });

  const { data: pulseAgencyLookup = [] } = useQuery({
    queryKey: [
      "pulse-mappings-agency-lookup",
      mappedPulseAgencyIds,
      mappedPulseAgencyReaIds,
    ],
    queryFn: async () => {
      if (mappedPulseAgencyIds.length === 0 && mappedPulseAgencyReaIds.length === 0) {
        return [];
      }
      const filters = [];
      if (mappedPulseAgencyIds.length > 0) {
        filters.push(`id.in.(${mappedPulseAgencyIds.join(",")})`);
      }
      if (mappedPulseAgencyReaIds.length > 0) {
        const quoted = mappedPulseAgencyReaIds.map((v) => `"${v}"`).join(",");
        filters.push(`rea_agency_id.in.(${quoted})`);
      }
      const { data, error } = await supabase
        .from("pulse_agencies")
        .select("id, name, rea_agency_id")
        .or(filters.join(","));
      if (error) throw error;
      return data || [];
    },
    staleTime: 5 * 60 * 1000,
    enabled:
      pulseAgencies.length === 0 &&
      (mappedPulseAgencyIds.length > 0 || mappedPulseAgencyReaIds.length > 0),
  });

  // Use parent-provided arrays when available; otherwise fall back to our
  // own projection. Prevents duplicate fetches if IndustryPulse is ever
  // reverted to pass these props.
  const effectivePulseAgents = pulseAgents.length > 0 ? pulseAgents : pulseAgentLookup;
  const effectivePulseAgencies = pulseAgencies.length > 0 ? pulseAgencies : pulseAgencyLookup;

  // Resolved rows
  const rows = useMemo(() => {
    return pulseMappings.map((m) => {
      const pulseRecord =
        m.entity_type === "agency"
          ? effectivePulseAgencies.find(
              (a) => a.id === m.pulse_entity_id || (a.rea_agency_id && a.rea_agency_id === m.rea_id)
            )
          : effectivePulseAgents.find(
              (a) => a.id === m.pulse_entity_id || a.rea_agent_id === m.rea_id
            );

      const crmRecord =
        m.entity_type === "agency"
          ? crmAgencies.find((a) => a.id === m.crm_entity_id)
          : crmAgents.find((a) => a.id === m.crm_entity_id);

      const pulseName =
        (m.entity_type === "agent" ? pulseRecord?.full_name : pulseRecord?.name) ||
        pulseRecord?.agent_name ||
        pulseRecord?.agency_name ||
        null;

      const crmName =
        crmRecord?.name ||
        crmRecord?.agent_name ||
        crmRecord?.agency_name ||
        null;

      return { mapping: m, pulseName, crmName };
    });
  }, [pulseMappings, effectivePulseAgents, effectivePulseAgencies, crmAgents, crmAgencies]);

  // Filtered rows
  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return rows.filter(({ mapping, pulseName, crmName }) => {
      if (filterConfidence !== "all" && mapping.confidence !== filterConfidence) return false;
      if (filterType !== "all" && mapping.entity_type !== filterType) return false;
      if (q) {
        const hay = [pulseName, crmName, mapping.rea_id, mapping.entity_type]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filterConfidence, filterType, searchText]);

  // Counts for filter badges
  const counts = useMemo(() => {
    const confirmed = pulseMappings.filter((m) => m.confidence === "confirmed").length;
    const suggested = pulseMappings.filter((m) => m.confidence === "suggested").length;
    return { all: pulseMappings.length, confirmed, suggested };
  }, [pulseMappings]);

  // QoL #64: mappings that qualify for one-click auto-confirm.
  // Criteria: match_type === "rea_id+name" (both REA ID AND name matched) AND
  // confidence === "suggested" (awaiting human approval). Strongest match
  // strategy in pulseDataSync — the only reason these aren't already confirmed
  // is that nobody has clicked the green check yet.
  const exactMatchSuggested = useMemo(
    () => pulseMappings.filter((m) => m.match_type === "rea_id+name" && m.confidence === "suggested"),
    [pulseMappings],
  );

  const handleConfirm = useCallback(async (mapping) => {
    setConfirming(mapping.id);
    try {
      await api.entities.PulseCrmMapping.update(mapping.id, { confidence: "confirmed" });
      await refetchEntityList("PulseCrmMapping");
      toast.success("Mapping confirmed");
    } catch (err) {
      toast.error(`Failed to confirm: ${err.message}`);
    } finally {
      setConfirming(null);
    }
  }, []);

  // QoL #63: per-row selection toggle.
  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  // Select-all applies to the CURRENTLY FILTERED rows — matches on-screen
  // selection intent rather than every mapping in the table.
  const toggleSelectAllFiltered = useCallback(() => {
    setSelectedIds((prev) => {
      const ids = filtered.map((r) => r.mapping.id);
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      const n = new Set(prev);
      if (allSelected) { for (const id of ids) n.delete(id); }
      else { for (const id of ids) n.add(id); }
      return n;
    });
  }, [filtered]);

  // QoL #63: bulk confirm — only rows that aren't already confirmed.
  const bulkConfirm = useCallback(async () => {
    const ids = filtered
      .filter((r) => selectedIds.has(r.mapping.id) && r.mapping.confidence !== "confirmed")
      .map((r) => r.mapping.id);
    if (!ids.length) { toast.info("No unconfirmed mappings selected"); return; }
    setBulkBusy(true);
    try {
      const { error, count } = await api._supabase
        .from("pulse_crm_mappings")
        .update({ confidence: "confirmed" }, { count: "exact" })
        .in("id", ids);
      if (error) throw error;
      await refetchEntityList("PulseCrmMapping");
      setSelectedIds(new Set());
      toast.success(`Confirmed ${count ?? ids.length} mapping${ids.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(`Bulk confirm failed: ${err.message}`);
    } finally {
      setBulkBusy(false);
    }
  }, [filtered, selectedIds]);

  // QoL #63: bulk reject (hard-delete) for every selected row.
  const bulkReject = useCallback(async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const { error, count } = await api._supabase
        .from("pulse_crm_mappings")
        .delete({ count: "exact" })
        .in("id", ids);
      if (error) throw error;
      await refetchEntityList("PulseCrmMapping");
      setSelectedIds(new Set());
      toast.success(`Deleted ${count ?? ids.length} mapping${ids.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(`Bulk delete failed: ${err.message}`);
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds]);

  // ── Linkage integrity (migration 191) ────────────────────────────────────
  // Surfaces pulse_linkage_issues rows — agencies/agents with is_in_crm=true
  // but linked_*_id NULL (and their inverses). Auto-reconciler runs nightly;
  // this panel lets an admin kick it off manually and accept/reject the
  // lower-confidence proposals that don't cross the 0.9 auto-apply bar.
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [orphanActionBusy, setOrphanActionBusy] = useState(null); // issue id

  const { data: linkageIssues = [], refetch: refetchLinkageIssues } = useQuery({
    queryKey: ["pulse-linkage-issues"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pulse_linkage_issues")
        .select("id, entity_type, entity_id, issue_type, detected_at, proposed_crm_id, proposed_confidence, runner_up_crm_id, runner_up_confidence, auto_fixed, notes")
        .is("resolved_at", null)
        .order("detected_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data || [];
    },
    staleTime: 60 * 1000,
  });

  const orphanRows = useMemo(() => {
    // Shape the rows to a common {kind: 'linkage_orphan', ...} structure that
    // downstream UI code can branch on alongside the existing mapping rows.
    return linkageIssues.map((iss) => {
      const pulseRow = iss.entity_type === "agency"
        ? effectivePulseAgencies.find((a) => a.id === iss.entity_id)
        : effectivePulseAgents.find((a) => a.id === iss.entity_id);
      const crmRow = iss.entity_type === "agency"
        ? crmAgencies.find((a) => a.id === iss.proposed_crm_id)
        : crmAgents.find((a) => a.id === iss.proposed_crm_id);
      const runnerUp = iss.entity_type === "agency"
        ? crmAgencies.find((a) => a.id === iss.runner_up_crm_id)
        : crmAgents.find((a) => a.id === iss.runner_up_crm_id);
      return {
        kind: "linkage_orphan",
        issue: iss,
        pulseId: iss.entity_id,
        pulseName: pulseRow?.full_name || pulseRow?.name || "(unknown)",
        topMatchCrmId: iss.proposed_crm_id,
        topMatchCrmName: crmRow?.name || null,
        topMatchConfidence: Number(iss.proposed_confidence ?? 0),
        runnerUpCrmName: runnerUp?.name || null,
        runnerUpConfidence: Number(iss.runner_up_confidence ?? 0),
      };
    });
  }, [linkageIssues, effectivePulseAgencies, effectivePulseAgents, crmAgencies, crmAgents]);

  const runReconcile = useCallback(async () => {
    setReconcileBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("pulseReconcileCrmLinks", {
        body: {},
      });
      if (error) throw error;
      const t = data?.totals || {};
      toast.success(
        `Reconcile complete: ${t.auto_applied ?? 0} auto-linked, ` +
        `${t.proposed_for_review ?? 0} to review, ${t.ambiguous ?? 0} ambiguous`
      );
      await refetchLinkageIssues();
    } catch (err) {
      toast.error(`Reconcile failed: ${err.message}`);
    } finally {
      setReconcileBusy(false);
    }
  }, [refetchLinkageIssues]);

  // Accept a proposed auto-link — updates the pulse_* row; the trigger then
  // emits the timeline event + marks the substrate stale, and marks the
  // pulse_linkage_issues row resolved.
  const acceptOrphan = useCallback(async (row) => {
    if (!row?.topMatchCrmId) { toast.error("No proposed CRM match to accept"); return; }
    setOrphanActionBusy(row.issue.id);
    try {
      const table = row.issue.entity_type === "agency" ? "pulse_agencies" : "pulse_agents";
      const column = row.issue.entity_type === "agency" ? "linked_agency_id" : "linked_agent_id";
      const { error } = await supabase.from(table)
        .update({ [column]: row.topMatchCrmId })
        .eq("id", row.pulseId);
      if (error) throw error;
      toast.success(`Linked ${row.pulseName} to ${row.topMatchCrmName || "CRM record"}`);
      await refetchLinkageIssues();
    } catch (err) {
      toast.error(`Accept failed: ${err.message}`);
    } finally {
      setOrphanActionBusy(null);
    }
  }, [refetchLinkageIssues]);

  // Reject — mark issue resolved without linking (human says "this is wrong
  // or not resolvable"). Human can re-run reconcile later.
  const rejectOrphan = useCallback(async (row) => {
    setOrphanActionBusy(row.issue.id);
    try {
      const { error } = await supabase.from("pulse_linkage_issues")
        .update({ resolved_at: new Date().toISOString(), notes: (row.issue.notes || "") + " | rejected by user" })
        .eq("id", row.issue.id);
      if (error) throw error;
      toast.success("Marked as reviewed");
      await refetchLinkageIssues();
    } catch (err) {
      toast.error(`Reject failed: ${err.message}`);
    } finally {
      setOrphanActionBusy(null);
    }
  }, [refetchLinkageIssues]);

  const ignoreOrphan = rejectOrphan; // same backend action, different UI label

  // QoL #64: auto-confirm every rea_id+name match still in "suggested" state.
  const runAutoConfirm = useCallback(async () => {
    const ids = exactMatchSuggested.map((m) => m.id);
    if (!ids.length) { setAutoConfirmOpen(false); return; }
    setAutoConfirmBusy(true);
    try {
      const { error, count } = await api._supabase
        .from("pulse_crm_mappings")
        .update({ confidence: "confirmed" }, { count: "exact" })
        .in("id", ids);
      if (error) throw error;
      await refetchEntityList("PulseCrmMapping");
      toast.success(`Auto-confirmed ${count ?? ids.length} exact-match mapping${ids.length === 1 ? "" : "s"}`);
      setAutoConfirmOpen(false);
    } catch (err) {
      toast.error(`Auto-confirm failed: ${err.message}`);
    } finally {
      setAutoConfirmBusy(false);
    }
  }, [exactMatchSuggested]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.mapping.id));
  const selectedOnScreen = filtered.filter((r) => selectedIds.has(r.mapping.id)).length;

  // Opens confirmation dialog
  const handleRejectRequest = useCallback((mapping) => {
    setRejectCandidate(mapping);
  }, []);

  // Executes the actual delete after confirmation
  const handleRejectConfirm = useCallback(async () => {
    if (!rejectCandidate) return;
    setRejecting(rejectCandidate.id);
    setRejectCandidate(null);
    try {
      await api.entities.PulseCrmMapping.delete(rejectCandidate.id);
      await refetchEntityList("PulseCrmMapping");
      toast.success("Mapping removed");
    } catch (err) {
      toast.error(`Failed to remove: ${err.message}`);
    } finally {
      setRejecting(null);
    }
  }, [rejectCandidate]);

  return (
    <div className="space-y-4">
      {/* ── Linkage integrity card (migration 191) ── */}
      {orphanRows.length > 0 && (
        <Card className="rounded-xl border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/10 shadow-sm">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-300">
                    Linkage integrity
                  </h3>
                  <p className="text-xs text-amber-800/80 dark:text-amber-300/70 mt-0.5">
                    <strong>{orphanRows.length}</strong> entit{orphanRows.length === 1 ? "y is" : "ies are"}{" "}
                    flagged as in CRM but missing the direct link — price matrix and package
                    overrides will silently skip their listings until resolved.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs gap-1 border-amber-400/60 bg-white dark:bg-amber-900/20"
                onClick={runReconcile}
                disabled={reconcileBusy}
                title="Re-run fuzzy-match reconciler against CRM agencies/agents"
              >
                {reconcileBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Reconcile now
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-amber-200/60 text-amber-900/80 dark:text-amber-300/70">
                    <th className="text-left py-1.5 pr-3 font-medium">Type</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Pulse</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Proposed CRM match</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Confidence</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Runner-up</th>
                    <th className="text-right py-1.5 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orphanRows.map((row) => {
                    const pct = Math.round((row.topMatchConfidence || 0) * 100);
                    const runnerPct = Math.round((row.runnerUpConfidence || 0) * 100);
                    const busy = orphanActionBusy === row.issue.id;
                    const canAccept = !!row.topMatchCrmId && row.topMatchConfidence >= 0.5;
                    return (
                      <tr key={row.issue.id} className="border-b border-amber-100 last:border-0 align-top">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-1.5">
                            {row.issue.entity_type === "agency"
                              ? <Building2 className="h-3.5 w-3.5 text-violet-500 shrink-0" />
                              : <Users className="h-3.5 w-3.5 text-blue-500 shrink-0" />}
                            <span className="capitalize">{row.issue.entity_type}</span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 max-w-[200px]">
                          <div className="font-medium truncate">{row.pulseName}</div>
                        </td>
                        <td className="py-2 pr-3 max-w-[220px]">
                          <div className="truncate">
                            {row.topMatchCrmName || <span className="italic text-muted-foreground">no match</span>}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <Badge
                            className={cn(
                              "text-[10px] px-1.5 py-0",
                              pct >= 90 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                : pct >= 70 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                            )}
                          >
                            {pct}%
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 text-[10px] text-muted-foreground max-w-[180px] truncate">
                          {row.runnerUpCrmName
                            ? <>{row.runnerUpCrmName} ({runnerPct}%)</>
                            : <span className="italic">—</span>}
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex items-center justify-end gap-1 flex-wrap">
                            {canAccept && (
                              <Button
                                size="sm" variant="outline"
                                className="h-6 px-2 text-[10px] gap-1 border-emerald-400/60 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400"
                                onClick={() => acceptOrphan(row)}
                                disabled={busy}
                                title={`Set ${row.issue.entity_type === 'agency' ? 'linked_agency_id' : 'linked_agent_id'} to ${row.topMatchCrmName}`}
                              >
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                                Accept ({pct}%)
                              </Button>
                            )}
                            <Button
                              size="sm" variant="ghost"
                              className="h-6 px-2 text-[10px] gap-1 text-red-600 hover:bg-red-50"
                              onClick={() => rejectOrphan(row)}
                              disabled={busy}
                              title="Dismiss — the reconciler will propose again next run"
                            >
                              <XCircle className="h-3 w-3" />
                              Reject
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:bg-muted"
                              onClick={() => ignoreOrphan(row)}
                              disabled={busy}
                              title="Mark as reviewed without action"
                            >
                              <ChevronRight className="h-3 w-3" />
                              Ignore
                            </Button>
                          </div>
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

      {/* ── Header + filters ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">CRM Mappings</h2>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{filtered.length}</Badge>
          {/* QoL #64: auto-confirm every exact-match (rea_id+name) suggestion */}
          {exactMatchSuggested.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs gap-1 border-emerald-400/60 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
              onClick={() => setAutoConfirmOpen(true)}
              title="Auto-confirm mappings where both REA ID and full name matched exactly"
            >
              <Sparkles className="h-3 w-3" />
              Auto-confirm {exactMatchSuggested.length} exact match{exactMatchSuggested.length === 1 ? "" : "es"}
            </Button>
          )}
        </div>

        {/* Search filter */}
        <div className="relative w-full sm:w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search mappings..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="h-7 text-xs pl-7 pr-7"
          />
          {searchText && (
            <button
              onClick={() => setSearchText("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Confidence filter */}
        <div className="flex items-center gap-1 flex-wrap">
          {FILTER_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={filterConfidence === opt.value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setFilterConfidence(opt.value)}
            >
              {opt.label}
              {opt.value !== "all" && (
                <Badge
                  className={cn(
                    "ml-1.5 text-[9px] px-1 py-0",
                    opt.value === "confirmed"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  )}
                >
                  {counts[opt.value] ?? 0}
                </Badge>
              )}
            </Button>
          ))}
          <span className="text-muted-foreground text-xs mx-1">|</span>
          {TYPE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={filterType === opt.value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setFilterType(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* QoL #63: sticky bulk-action bar — shows only while ≥1 on-screen row is ticked */}
      {selectedOnScreen > 0 && (
        <div className="sticky top-2 z-10 flex items-center justify-between gap-2 rounded-lg border bg-background/95 backdrop-blur px-3 py-2 shadow-sm">
          <span className="text-xs">
            <strong>{selectedOnScreen}</strong> mapping{selectedOnScreen === 1 ? "" : "s"} selected
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs gap-1 border-emerald-400/60 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400"
              onClick={bulkConfirm}
              disabled={bulkBusy}
            >
              {bulkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Confirm {selectedOnScreen}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs gap-1 border-red-400/60 text-red-700 hover:bg-red-50 dark:text-red-400"
              onClick={bulkReject}
              disabled={bulkBusy}
            >
              <XCircle className="h-3 w-3" />
              Reject {selectedOnScreen}
            </Button>
            <Button
              size="sm" variant="ghost" className="h-7 px-2 text-xs"
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkBusy}
            >
              <X className="h-3 w-3" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <Card className="rounded-xl border shadow-sm">
        <CardContent className="p-0 overflow-x-auto">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No mappings found.
            </div>
          ) : (
            <table className="w-full text-xs min-w-[740px]">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left pl-4 pr-2 py-2.5 w-[32px]">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAllFiltered}
                      className="h-3.5 w-3.5"
                      aria-label="Select all filtered mappings"
                    />
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Type</th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Pulse Entity</th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">CRM Entity</th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Match</th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Confidence</th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Created</th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ mapping, pulseName, crmName }) => (
                  <MappingRow
                    key={mapping.id}
                    mapping={mapping}
                    pulseName={pulseName}
                    crmName={crmName}
                    onConfirm={handleConfirm}
                    onReject={handleRejectRequest}
                    confirming={confirming}
                    rejecting={rejecting}
                    selected={selectedIds.has(mapping.id)}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ── Empty state for no mappings at all ── */}
      {pulseMappings.length === 0 && (
        <Card className="rounded-xl border shadow-sm">
          <CardContent className="py-12 text-center">
            <Link2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No mappings yet</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Run a scrape and the system will auto-suggest mappings between Pulse records and CRM contacts.
            </p>
          </CardContent>
        </Card>
      )}

      {/* QoL #64: Auto-confirm exact-match dialog */}
      {autoConfirmOpen && (
        <Dialog open onOpenChange={(o) => { if (!o) setAutoConfirmOpen(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-emerald-600" />
                Auto-confirm exact-match mappings
              </DialogTitle>
            </DialogHeader>
            <div className="text-xs text-muted-foreground space-y-2 py-2">
              <p>
                This will set <strong>confidence = confirmed</strong> on{" "}
                <strong className="text-emerald-700 dark:text-emerald-400">
                  {exactMatchSuggested.length} mapping{exactMatchSuggested.length === 1 ? "" : "s"}
                </strong>{" "}
                that currently match both:
              </p>
              <ul className="list-disc pl-5 space-y-0.5">
                <li><code className="font-mono text-[10px]">match_type = "rea_id+name"</code> (REA ID AND full name match exactly)</li>
                <li><code className="font-mono text-[10px]">confidence = "suggested"</code> (awaiting human confirmation)</li>
              </ul>
              <p className="italic">
                Rows with fuzzy or single-signal matches are not affected. You
                can still Reject any row manually afterwards.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAutoConfirmOpen(false)}
                disabled={autoConfirmBusy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={runAutoConfirm}
                disabled={autoConfirmBusy}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {autoConfirmBusy
                  ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Confirming…</>
                  : `Confirm all ${exactMatchSuggested.length}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Reject confirmation dialog ── */}
      {rejectCandidate && (
        <Dialog open onOpenChange={(open) => { if (!open) setRejectCandidate(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm flex items-center gap-2">
                <XCircle className="h-4 w-4 text-red-500" />
                Remove Mapping
              </DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground py-2">
              Are you sure you want to delete this{" "}
              <strong>{rejectCandidate.entity_type}</strong> mapping? This
              action cannot be undone.
            </p>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRejectCandidate(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleRejectConfirm}
              >
                Delete Mapping
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

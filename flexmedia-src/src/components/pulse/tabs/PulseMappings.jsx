/**
 * PulseMappings — Industry Pulse "Mappings" tab.
 * Shows pulse_crm_mappings with confirm/reject actions.
 */
import React, { useState, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { api } from "@/api/supabaseClient";
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
import { CheckCircle2, XCircle, Link2, Users, Building2, ExternalLink, Search, X } from "lucide-react";

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

function MappingRow({ mapping, pulseName, crmName, onConfirm, onReject, confirming, rejecting }) {
  return (
    <tr className="border-b last:border-0 hover:bg-muted/30 transition-colors align-top">
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

  // Resolved rows
  const rows = useMemo(() => {
    return pulseMappings.map((m) => {
      const pulseRecord =
        m.entity_type === "agency"
          ? pulseAgencies.find(
              (a) => a.id === m.pulse_entity_id || (a.rea_agency_id && a.rea_agency_id === m.rea_id)
            )
          : pulseAgents.find(
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
  }, [pulseMappings, pulseAgents, pulseAgencies, crmAgents, crmAgencies]);

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
      {/* ── Header + filters ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">CRM Mappings</h2>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{filtered.length}</Badge>
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

      {/* ── Table ── */}
      <Card className="rounded-xl border shadow-sm">
        <CardContent className="p-0 overflow-x-auto">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No mappings found.
            </div>
          ) : (
            <table className="w-full text-xs min-w-[700px]">
              <thead>
                <tr className="border-b bg-muted/30">
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

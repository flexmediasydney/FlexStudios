/**
 * PulseLinkCard — always-visible card on PersonDetails / OrgDetails that lets
 * the user link a CRM agent/agency to its Industry Pulse counterpart.
 *
 * States it covers:
 *   • Linked        → show pulse name + Open + Unlink
 *   • Dismissed     → "Marked as not in Industry Pulse"  + Undo
 *   • Suggesting    → top-N suggestions from pulse_suggest_crm_links + search
 *
 * Backed by RPCs introduced in migration 348:
 *   pulse_suggest_crm_links / pulse_apply_crm_link /
 *   pulse_unlink_crm        / pulse_dismiss_crm_link / pulse_undismiss_crm_link
 *
 * Props:
 *   entityType — 'agent' | 'agency'
 *   crmId      — uuid of the CRM record being viewed
 *   crmName    — display name (used to seed the search box)
 */
import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Link2, ExternalLink, Search, X, Loader2, Sparkles,
  Check, Undo2, AlertTriangle,
} from "lucide-react";

const TABLE = (et) => (et === "agency" ? "pulse_agencies" : "pulse_agents");
const NAME_COL = (et) => (et === "agency" ? "name" : "full_name");
const PULSE_TAB = (et) => (et === "agency" ? "agencies" : "agents");

function ConfidenceBar({ score }) {
  const pct = Math.round((Number(score) || 0) * 100);
  const tone =
    pct >= 90 ? "bg-emerald-500" : pct >= 70 ? "bg-amber-500" : "bg-slate-400";
  return (
    <div className="flex items-center gap-1.5 min-w-[90px]">
      <div className="h-1.5 w-14 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function PulseLinkCard({ entityType, crmId, crmName }) {
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState("");

  // ── Current link state ────────────────────────────────────────────────────
  // Mapping row keyed by (entity_type, crm_entity_id) — single source of truth
  // for "is this CRM record linked / dismissed / unlinked".
  const mappingQ = useQuery({
    queryKey: ["pulse-link-mapping", entityType, crmId],
    queryFn: async () => {
      const { data } = await supabase
        .from("pulse_crm_mappings")
        .select("id, pulse_entity_id, match_type, confidence")
        .eq("entity_type", entityType)
        .eq("crm_entity_id", crmId)
        .maybeSingle();
      return data || null;
    },
    enabled: !!crmId,
    staleTime: 60_000,
  });

  const mapping = mappingQ.data;
  const isLinked = !!mapping?.pulse_entity_id;
  const isDismissed = mapping?.match_type === "no_link";

  // ── Linked pulse details (for the linked-state card) ──────────────────────
  const linkedPulseQ = useQuery({
    queryKey: ["pulse-link-linked-row", entityType, mapping?.pulse_entity_id],
    queryFn: async () => {
      if (!mapping?.pulse_entity_id) return null;
      const { data } = await supabase
        .from(TABLE(entityType))
        .select(`id, ${NAME_COL(entityType)}, rea_${entityType}_id`)
        .eq("id", mapping.pulse_entity_id)
        .maybeSingle();
      return data || null;
    },
    enabled: isLinked,
    staleTime: 60_000,
  });

  // ── Auto-suggestions ──────────────────────────────────────────────────────
  const suggestionsQ = useQuery({
    queryKey: ["pulse-link-suggest", entityType, crmId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("pulse_suggest_crm_links", {
        p_entity_type: entityType,
        p_crm_id: crmId,
        p_limit: 5,
      });
      if (error) throw error;
      return data || [];
    },
    enabled: !!crmId && !isLinked && !isDismissed,
    staleTime: 60_000,
  });

  // ── Search results (typeahead) ────────────────────────────────────────────
  const debouncedSearch = useMemo(() => searchText.trim(), [searchText]);
  const searchQ = useQuery({
    queryKey: ["pulse-link-search", entityType, debouncedSearch],
    queryFn: async () => {
      if (!debouncedSearch || debouncedSearch.length < 2) return [];
      // Match on either name (ilike) or REA id (exact when numeric).
      const nameCol = NAME_COL(entityType);
      const reaCol = entityType === "agency" ? "rea_agency_id" : "rea_agent_id";
      const filters = [
        `${nameCol}.ilike.%${debouncedSearch.replace(/[%,()]/g, "")}%`,
        `${reaCol}.eq.${debouncedSearch.replace(/[^0-9A-Z]/gi, "")}`,
      ];
      const { data } = await supabase
        .from(TABLE(entityType))
        .select(`id, ${nameCol}, ${reaCol}, linked_${entityType}_id`)
        .or(filters.join(","))
        .limit(15);
      return (data || []).filter((r) => !r[`linked_${entityType}_id`]);
    },
    enabled: debouncedSearch.length >= 2 && !isLinked && !isDismissed,
    staleTime: 30_000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────
  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["pulse-link-mapping", entityType, crmId] });
    queryClient.invalidateQueries({ queryKey: ["pulse-link-suggest", entityType, crmId] });
    queryClient.invalidateQueries({ queryKey: ["pulse-link-linked-row", entityType] });
    queryClient.invalidateQueries({ queryKey: ["pulse-link-search"] });
    // Also invalidate other pulse-aware UIs that read this mapping.
    queryClient.invalidateQueries({ queryKey: ["person_pulse_mapping", crmId] });
    queryClient.invalidateQueries({ queryKey: ["pulse_agency_for_crm", crmId] });
  };

  const linkMut = useMutation({
    mutationFn: async (pulseId) => {
      const { error } = await supabase.rpc("pulse_apply_crm_link", {
        p_entity_type: entityType,
        p_crm_id: crmId,
        p_pulse_id: pulseId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Linked to Industry Pulse");
      invalidateAll();
    },
    onError: (err) => {
      console.error("pulse_apply_crm_link failed:", err);
      toast.error("Could not link record. Try again.");
    },
  });

  const unlinkMut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("pulse_unlink_crm", {
        p_entity_type: entityType,
        p_crm_id: crmId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Unlinked");
      invalidateAll();
    },
    onError: (err) => {
      console.error("pulse_unlink_crm failed:", err);
      toast.error("Could not unlink. Try again.");
    },
  });

  const dismissMut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("pulse_dismiss_crm_link", {
        p_entity_type: entityType,
        p_crm_id: crmId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Marked as not in Industry Pulse");
      invalidateAll();
    },
    onError: (err) => {
      console.error("pulse_dismiss_crm_link failed:", err);
      toast.error("Could not dismiss.");
    },
  });

  const undismissMut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("pulse_undismiss_crm_link", {
        p_entity_type: entityType,
        p_crm_id: crmId,
      });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(),
    onError: (err) => {
      console.error("pulse_undismiss_crm_link failed:", err);
      toast.error("Could not undo.");
    },
  });

  // ── Render ────────────────────────────────────────────────────────────────
  const busy =
    linkMut.isPending || unlinkMut.isPending ||
    dismissMut.isPending || undismissMut.isPending;

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
            <h3 className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
              Industry Pulse link
            </h3>
          </div>
          {mappingQ.isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>

        {/* ── Linked state ─────────────────────────────────────────────── */}
        {isLinked && (
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-emerald-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {linkedPulseQ.data?.[NAME_COL(entityType)] || "(loading…)"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {entityType === "agency" ? "Agency" : "Agent"} · {mapping.match_type}
              </p>
            </div>
            <Link
              to={`/IndustryPulse?tab=${PULSE_TAB(entityType)}&pulse_id=${mapping.pulse_entity_id}&entity_type=${entityType}`}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              Open <ExternalLink className="h-3 w-3" />
            </Link>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => unlinkMut.mutate()}
              disabled={busy}
            >
              {unlinkMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Unlink"}
            </Button>
          </div>
        )}

        {/* ── Dismissed state ──────────────────────────────────────────── */}
        {isDismissed && (
          <div className="flex items-center justify-between text-xs text-muted-foreground bg-muted/40 rounded px-2 py-2">
            <span className="flex items-center gap-2">
              <X className="h-3.5 w-3.5" />
              Marked as not in Industry Pulse.
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() => undismissMut.mutate()}
              disabled={busy}
            >
              {undismissMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : (
                <><Undo2 className="h-3 w-3 mr-1" /> Undo</>
              )}
            </Button>
          </div>
        )}

        {/* ── Suggesting state ─────────────────────────────────────────── */}
        {!isLinked && !isDismissed && (
          <div className="space-y-3">
            {/* Auto-suggestions */}
            {suggestionsQ.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Looking for matches…
              </div>
            ) : (suggestionsQ.data || []).length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Suggested matches
                </p>
                {(suggestionsQ.data || []).map((s) => (
                  <SuggestionRow
                    key={s.pulse_id}
                    suggestion={s}
                    entityType={entityType}
                    onLink={() => linkMut.mutate(s.pulse_id)}
                    busy={busy}
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No automatic matches found.
              </p>
            )}

            {/* Manual search */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Search Industry Pulse
              </p>
              <div className="relative">
                <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={`Search by ${entityType === "agency" ? "agency" : "agent"} name or REA ID…`}
                  className="h-8 text-xs pl-7"
                />
                {searchText && (
                  <button
                    type="button"
                    onClick={() => setSearchText("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              {debouncedSearch.length >= 2 && (
                <div className="border rounded max-h-48 overflow-auto">
                  {searchQ.isLoading ? (
                    <div className="p-2 text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                    </div>
                  ) : (searchQ.data || []).length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground italic">
                      No unlinked records match.
                    </div>
                  ) : (
                    (searchQ.data || []).map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs truncate">{r[NAME_COL(entityType)]}</p>
                          {r[`rea_${entityType}_id`] && (
                            <p className="text-[10px] text-muted-foreground">
                              REA {r[`rea_${entityType}_id`]}
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] px-2"
                          onClick={() => linkMut.mutate(r.id)}
                          disabled={busy}
                        >
                          {linkMut.isPending && linkMut.variables === r.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <><Check className="h-3 w-3 mr-1" /> Link</>
                          )}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Dismiss */}
            <div className="flex justify-end pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] text-muted-foreground"
                onClick={() => dismissMut.mutate()}
                disabled={busy}
              >
                Not in Industry Pulse
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({ suggestion, entityType, onLink, busy }) {
  const reasons = suggestion.match_reasons || [];
  const reasonLabel = reasons.length > 0 ? reasons.join(" · ") : "name";

  return (
    <div className="flex items-center gap-2 rounded border bg-card hover:bg-muted/30 px-2 py-1.5">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{suggestion.pulse_name || "(no name)"}</p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {entityType === "agent" && suggestion.pulse_agency_name && (
            <span className="truncate">{suggestion.pulse_agency_name}</span>
          )}
          {suggestion.pulse_rea_id && <span>REA {suggestion.pulse_rea_id}</span>}
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5">
            {reasonLabel}
          </Badge>
        </div>
      </div>
      <ConfidenceBar score={suggestion.score} />
      <Button
        size="sm"
        className="h-6 text-[10px] px-2"
        onClick={onLink}
        disabled={busy}
      >
        <Check className="h-3 w-3 mr-1" /> Link
      </Button>
    </div>
  );
}

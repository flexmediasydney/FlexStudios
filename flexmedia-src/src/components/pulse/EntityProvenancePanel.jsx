/**
 * EntityProvenancePanel — shows per-field provenance for a CRM agent / agency.
 *
 * Answers "where did this value come from?" for each editable field — name,
 * email, phone, title, etc. Each row displays:
 *   • field label
 *   • current promoted value
 *   • source badge (Industry Pulse · REA / Manual edit / Imported)
 *   • observed-at timestamp ("2 weeks ago")
 *   • pin/unpin button so the operator can lock the value against future
 *     Pulse scraper updates
 *
 * Backed by `pulse_get_field_provenance` (migration 352) and the existing
 * SAFR `lock_entity_field` / `unlock_entity_field` RPCs from migration 178.
 */
import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ScrollText, Lock, Unlock, Sparkles, User, Building2, Loader2,
  Database, Mail, Globe2, Edit3,
} from "lucide-react";

// ── Source → display ───────────────────────────────────────────────────────
// Maps SAFR source strings to a friendlier label, tone, and icon. Anything
// unrecognized falls through to a generic display.
const SOURCE_DISPLAY = {
  manual:               { label: "You",                  tone: "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20", icon: Edit3 },
  rea_scrape:           { label: "Industry Pulse · REA", tone: "text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/20",     icon: Sparkles },
  rea_listing_detail:   { label: "Industry Pulse · listing", tone: "text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/20", icon: Sparkles },
  domain_scrape:        { label: "Industry Pulse · Domain", tone: "text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/20",  icon: Sparkles },
  email_sync:           { label: "Email sync",           tone: "text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20",            icon: Mail },
  tonomo_webhook:       { label: "Tonomo",               tone: "text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20",            icon: Globe2 },
  legacy:               { label: "Imported",             tone: "text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-900/30",       icon: Database },
  enrichment_clearbit:  { label: "Clearbit",             tone: "text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20",            icon: Globe2 },
  import_csv:           { label: "CSV import",           tone: "text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-900/30",       icon: Database },
};

function getSourceMeta(source) {
  return (
    SOURCE_DISPLAY[source] || {
      label: source || "unknown",
      tone:  "text-muted-foreground bg-muted",
      icon:  Database,
    }
  );
}

function timeAgo(ts) {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(months / 12)} yr ago`;
}

export default function EntityProvenancePanel({ entityType, crmId }) {
  const queryClient = useQueryClient();

  const provQ = useQuery({
    queryKey: ["pulse-field-provenance", entityType, crmId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("pulse_get_field_provenance", {
        p_entity_type: entityType,
        p_crm_id: crmId,
      });
      if (error) throw error;
      return data || [];
    },
    enabled: !!crmId,
    staleTime: 30_000,
  });

  // SAFR contact/organization entity_type for the lock RPCs.
  const efsType = entityType === "agency" ? "organization" : "contact";

  const lockMut = useMutation({
    mutationFn: async ({ field_name, value_normalized }) => {
      const { error } = await supabase.rpc("lock_entity_field", {
        p_entity_type: efsType,
        p_entity_id: crmId,
        p_field_name: field_name,
        p_value_normalized: value_normalized,
        p_user_id: null,  // optional metadata; lock RPC tolerates null
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(`Locked ${vars.field_label || vars.field_name}`);
      queryClient.invalidateQueries({ queryKey: ["pulse-field-provenance", entityType, crmId] });
    },
    onError: (err) => {
      console.error("lock_entity_field failed:", err);
      toast.error("Could not lock field.");
    },
  });

  const unlockMut = useMutation({
    mutationFn: async ({ field_name }) => {
      const { error } = await supabase.rpc("unlock_entity_field", {
        p_entity_type: efsType,
        p_entity_id: crmId,
        p_field_name: field_name,
        p_user_id: null,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(`Unlocked ${vars.field_label || vars.field_name}`);
      queryClient.invalidateQueries({ queryKey: ["pulse-field-provenance", entityType, crmId] });
    },
    onError: (err) => {
      console.error("unlock_entity_field failed:", err);
      toast.error("Could not unlock field.");
    },
  });

  // Group by field_name → { promoted, alternates: [...] }
  const fields = React.useMemo(() => {
    const byField = new Map();
    for (const r of provQ.data || []) {
      if (!byField.has(r.field_name)) {
        byField.set(r.field_name, {
          field_name: r.field_name,
          field_label: r.field_label,
          legacy_column: r.legacy_column,
          promoted: null,
          alternates: [],
        });
      }
      const entry = byField.get(r.field_name);
      if (r.is_promoted) entry.promoted = r;
      else if (r.source_id) entry.alternates.push(r);
    }
    return Array.from(byField.values());
  }, [provQ.data]);

  if (provQ.isLoading) {
    return (
      <Card>
        <CardContent className="p-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading field sources…
        </CardContent>
      </Card>
    );
  }

  if (fields.length === 0) {
    return null; // nothing to show — entity isn't in SAFR yet
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <ScrollText className="h-3.5 w-3.5 text-slate-500" />
          <h3 className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
            Field sources
          </h3>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Where each value came from. Lock a field to prevent future Industry
          Pulse scraper updates from overwriting it.
        </p>

        <TooltipProvider delayDuration={200}>
          <div className="divide-y">
            {fields.map((f) => (
              <FieldRow
                key={f.field_name}
                field={f}
                isLocking={lockMut.isPending && lockMut.variables?.field_name === f.field_name}
                isUnlocking={unlockMut.isPending && unlockMut.variables?.field_name === f.field_name}
                onLock={() => f.promoted && lockMut.mutate({
                  field_name: f.field_name,
                  field_label: f.field_label,
                  // value_normalized comes from the promoted row; the lock RPC
                  // expects the canonical normalized form.
                  value_normalized: f.promoted.value_display,  // RPC normalizes server-side
                })}
                onUnlock={() => unlockMut.mutate({
                  field_name: f.field_name,
                  field_label: f.field_label,
                })}
              />
            ))}
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}

function FieldRow({ field, onLock, onUnlock, isLocking, isUnlocking }) {
  const promoted = field.promoted;
  const meta = getSourceMeta(promoted?.source);
  const Icon = meta.icon;

  return (
    <div className="py-2 flex items-center gap-2">
      <div className="w-16 shrink-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {field.field_label}
        </p>
      </div>

      <div className="flex-1 min-w-0">
        {promoted ? (
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate">{promoted.value_display || <span className="italic text-muted-foreground">(empty)</span>}</p>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] px-1.5 py-0 h-4 gap-1 border-transparent", meta.tone)}
                >
                  <Icon className="h-2.5 w-2.5" />
                  {meta.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                <p><span className="font-semibold">Source:</span> {promoted.source}</p>
                <p><span className="font-semibold">Confidence:</span> {Math.round((promoted.confidence || 0) * 100)}%</p>
                <p><span className="font-semibold">Observed:</span> {timeAgo(promoted.observed_at)}</p>
                {field.alternates.length > 0 && (
                  <>
                    <p className="font-semibold mt-1">Other sources:</p>
                    <ul className="text-[11px] list-disc ml-4">
                      {field.alternates.map((a) => (
                        <li key={a.source_id}>
                          {a.value_display} <span className="text-muted-foreground">· {a.source}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">no observation</p>
        )}
      </div>

      <div className="shrink-0">
        {promoted?.is_locked ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-amber-600"
                onClick={onUnlock}
                disabled={isUnlocking}
              >
                {isUnlocking
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Lock className="h-3 w-3 fill-current" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Locked — Pulse can't change this. Click to unlock.</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-amber-600"
                onClick={onLock}
                disabled={!promoted || isLocking}
              >
                {isLocking
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Unlock className="h-3 w-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Lock current value (block future Pulse updates)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

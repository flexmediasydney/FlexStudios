/**
 * SettingsDataConsistency.jsx — admin page exposing SAFR resolver state.
 *
 * Three tabs, all server-paginated:
 *
 *   1. Conflicts       — pulse_list_field_conflicts() — entities where the
 *                        promoted value disagrees with at least one active
 *                        alternate. Inline "Keep current", "Use alternate",
 *                        "Dismiss alternate" + bulk "Apply decisions".
 *   2. Locked fields   — pulse_list_locked_fields() — user-intent freezes.
 *                        Admin unlock action per row.
 *   3. Recent changes  — last 100 pulse_timeline rows with event_type in
 *                        ('field_promoted', 'field_locked', 'field_unlocked',
 *                        'field_dismissed') — before/after diff.
 *
 * Permissions: admin and above (enforced by route access + PermissionGuard).
 */

import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import {
  PermissionGuard, usePermissions,
} from "@/components/auth/PermissionGuard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle, Lock, LockOpen, History, ShieldCheck, Loader2, CheckCircle2,
  ArrowRight, ChevronLeft, ChevronRight, Database, RefreshCw, Inbox,
  Timer, Gauge,
} from "lucide-react";
import FieldSourceChip from "@/components/fieldSources/FieldSourceChip";
import { useSafrMutations } from "@/components/fieldSources/safrHooks";

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtRel(ts) {
  if (!ts) return "—";
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); }
  catch { return "—"; }
}
function fmtAbs(ts) {
  if (!ts) return "—";
  try { return format(new Date(ts), "PPpp"); } catch { return "—"; }
}

// ── Stats strip ───────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, loading, tone = "default" }) {
  const toneClasses = {
    default: "text-foreground",
    warning: "text-amber-600 dark:text-amber-400",
    success: "text-emerald-600 dark:text-emerald-400",
    info: "text-blue-600 dark:text-blue-400",
  };
  return (
    <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
      <div className={`rounded-md bg-muted p-2 ${toneClasses[tone]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold tabular-nums ${toneClasses[tone]}`}>
          {loading ? <Skeleton className="h-6 w-12" /> : Number(value || 0).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

function StatsStrip() {
  const { data, isLoading } = useQuery({
    queryKey: ["safr", "consistency_stats"],
    queryFn: () => api.rpc("pulse_data_consistency_stats"),
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard
        icon={AlertTriangle}
        label="Entities w/ conflicts"
        value={data?.entities_with_conflicts}
        loading={isLoading}
        tone="warning"
      />
      <StatCard
        icon={Database}
        label="Conflict pairs"
        value={data?.conflict_pairs}
        loading={isLoading}
        tone="warning"
      />
      <StatCard
        icon={Lock}
        label="Locked fields"
        value={data?.locked_fields}
        loading={isLoading}
        tone="info"
      />
      <StatCard
        icon={CheckCircle2}
        label="Auto-resolved (7d)"
        value={data?.auto_resolved_7d}
        loading={isLoading}
        tone="success"
      />
    </div>
  );
}

// ── Pagination controls ───────────────────────────────────────────────────

function Paginator({ offset, limit, hasMore, onPrev, onNext, totalLabel }) {
  return (
    <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
      <div>
        {totalLabel ? totalLabel : `Rows ${offset + 1}–${offset + limit}`}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 px-2" disabled={offset === 0} onClick={onPrev}>
          <ChevronLeft className="h-3 w-3 mr-1" /> Prev
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2" disabled={!hasMore} onClick={onNext}>
          Next <ChevronRight className="h-3 w-3 ml-1" />
        </Button>
      </div>
    </div>
  );
}

// ── Conflicts tab ─────────────────────────────────────────────────────────

const ENTITY_TYPE_FILTERS = [
  { value: "__all__", label: "All entity types" },
  { value: "contact", label: "Contacts" },
  { value: "organization", label: "Organisations" },
  { value: "agent", label: "Agents" },
  { value: "agency", label: "Agencies" },
  { value: "prospect", label: "Prospects" },
];

const FIELD_FILTERS = [
  { value: "__all__", label: "All fields" },
  { value: "mobile", label: "Mobile" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "full_name", label: "Full name" },
  { value: "job_title", label: "Job title" },
  { value: "website", label: "Website" },
  { value: "address", label: "Address" },
  { value: "profile_image", label: "Profile image" },
  { value: "linkedin_url", label: "LinkedIn URL" },
  { value: "logo_url", label: "Logo URL" },
];

function ConflictsTab() {
  const qc = useQueryClient();
  const [entityFilter, setEntityFilter] = useState("__all__");
  const [fieldFilter, setFieldFilter] = useState("__all__");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const limit = 25;

  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["safr", "conflicts", entityFilter, fieldFilter, offset],
    queryFn: () => api.rpc("pulse_list_field_conflicts", {
      p_entity_type: entityFilter === "__all__" ? null : entityFilter,
      p_field_name:  fieldFilter  === "__all__" ? null : fieldFilter,
      p_limit: limit,
      p_offset: offset,
    }),
    staleTime: 15 * 1000,
  });

  const resetSel = () => setSelected(new Set());
  const toggleSel = (key) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  // Bulk mutations call the individual RPCs one at a time — entity/field
  // combinations are heterogeneous so there is no single bulk RPC.
  const bulkApply = useMutation({
    mutationFn: async (decisions) => {
      const results = { ok: 0, failed: 0 };
      for (const { action, row } of decisions) {
        try {
          if (action === "use_alt") {
            await api.rpc("promote_entity_field", { p_source_id: row.alt_source_id, p_user_id: null });
          } else if (action === "dismiss_alt") {
            await api.rpc("dismiss_field_source", { p_source_id: row.alt_source_id, p_user_id: null, p_reason: "bulk dismiss" });
          } else if (action === "keep_current") {
            await api.rpc("dismiss_field_source", { p_source_id: row.alt_source_id, p_user_id: null, p_reason: "kept current value" });
          }
          results.ok++;
        } catch (e) {
          console.error("[bulk apply]", e);
          results.failed++;
        }
      }
      return results;
    },
    onSuccess: ({ ok, failed }) => {
      if (ok) toast.success(`Applied ${ok} decision${ok === 1 ? "" : "s"}`);
      if (failed) toast.error(`${failed} failed — check console`);
      qc.invalidateQueries({ queryKey: ["safr", "conflicts"] });
      qc.invalidateQueries({ queryKey: ["safr", "consistency_stats"] });
      resetSel();
    },
  });

  const rowKey = (r) => `${r.entity_type}:${r.entity_id}:${r.field_name}:${r.alt_source_id}`;

  const handleIndividual = async (row, action) => {
    try {
      if (action === "use_alt") {
        await api.rpc("promote_entity_field", { p_source_id: row.alt_source_id, p_user_id: null });
        toast.success("Alternate promoted");
      } else if (action === "dismiss_alt") {
        await api.rpc("dismiss_field_source", { p_source_id: row.alt_source_id, p_user_id: null, p_reason: "dismissed via data consistency" });
        toast.success("Alternate dismissed");
      } else if (action === "keep_current") {
        await api.rpc("dismiss_field_source", { p_source_id: row.alt_source_id, p_user_id: null, p_reason: "kept current" });
        toast.success("Kept current, alternate dismissed");
      }
      qc.invalidateQueries({ queryKey: ["safr", "conflicts"] });
      qc.invalidateQueries({ queryKey: ["safr", "consistency_stats"] });
    } catch (e) {
      toast.error(e?.message || "Action failed");
    }
  };

  const applyBulk = (defaultAction) => {
    const decisions = rows
      .filter(r => selected.has(rowKey(r)))
      .map(r => ({ action: defaultAction, row: r }));
    if (decisions.length === 0) { toast.error("Select rows first"); return; }
    bulkApply.mutate(decisions);
  };

  const hasMore = rows.length === limit;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={entityFilter} onValueChange={(v) => { setEntityFilter(v); setOffset(0); resetSel(); }}>
          <SelectTrigger className="h-8 w-[180px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ENTITY_TYPE_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={fieldFilter} onValueChange={(v) => { setFieldFilter(v); setOffset(0); resetSel(); }}>
          <SelectTrigger className="h-8 w-[180px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FIELD_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected` : ""}
          </span>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={selected.size === 0 || bulkApply.isPending}
            onClick={() => applyBulk("keep_current")}>
            Keep current
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={selected.size === 0 || bulkApply.isPending}
            onClick={() => applyBulk("use_alt")}>
            Use alternate
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs text-red-600" disabled={selected.size === 0 || bulkApply.isPending}
            onClick={() => applyBulk("dismiss_alt")}>
            Dismiss alternate
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-2"></th>
                <th className="text-left px-3 py-2">Entity</th>
                <th className="text-left px-3 py-2">Field</th>
                <th className="text-left px-3 py-2">Current</th>
                <th className="text-left px-3 py-2">Alternate</th>
                <th className="text-left px-3 py-2">Δ days</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && [...Array(5)].map((_, i) => (
                <tr key={i}><td colSpan={7} className="p-3"><Skeleton className="h-6 w-full" /></td></tr>
              ))}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-muted-foreground">
                  <Inbox className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No conflicts found.
                </td></tr>
              )}
              {rows.map(row => {
                const key = rowKey(row);
                const isSel = selected.has(key);
                return (
                  <tr key={key} className={`hover:bg-muted/30 ${isSel ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}>
                    <td className="px-2">
                      <Checkbox checked={isSel} onCheckedChange={() => toggleSel(key)} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium truncate max-w-[180px]">{row.entity_name || row.entity_id}</div>
                      <div className="text-[10px] text-muted-foreground capitalize">{row.entity_type}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.field_name}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate max-w-[160px]">{row.current_value || "—"}</span>
                        <FieldSourceChip source={row.current_source} size="xs" confidence={row.current_confidence} />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate max-w-[160px] text-amber-700 dark:text-amber-300">{row.alt_value || "—"}</span>
                        <FieldSourceChip source={row.alt_source} size="xs" confidence={row.alt_confidence} />
                      </div>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{row.observed_delta_days ?? "—"}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]"
                        onClick={() => handleIndividual(row, "keep_current")}>
                        Keep
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-emerald-700 dark:text-emerald-400"
                        onClick={() => handleIndividual(row, "use_alt")}>
                        Use alt
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-red-600 dark:text-red-400"
                        onClick={() => handleIndividual(row, "dismiss_alt")}>
                        Dismiss
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Paginator
        offset={offset}
        limit={limit}
        hasMore={hasMore}
        onPrev={() => setOffset(Math.max(0, offset - limit))}
        onNext={() => setOffset(offset + limit)}
      />
    </div>
  );
}

// ── Locked fields tab ─────────────────────────────────────────────────────

function LockedFieldsTab() {
  const qc = useQueryClient();
  const { isAdminOrAbove } = usePermissions();
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["safr", "locked_fields", offset],
    queryFn: () => api.rpc("pulse_list_locked_fields", { p_limit: limit, p_offset: offset }),
    staleTime: 30 * 1000,
  });

  const unlockMut = useMutation({
    mutationFn: async ({ entity_type, entity_id, field_name }) => api.rpc("unlock_entity_field", {
      p_entity_type: entity_type, p_entity_id: entity_id, p_field_name: field_name, p_user_id: null,
    }),
    onSuccess: () => {
      toast.success("Unlocked");
      qc.invalidateQueries({ queryKey: ["safr", "locked_fields"] });
      qc.invalidateQueries({ queryKey: ["safr", "consistency_stats"] });
    },
    onError: (e) => toast.error(e?.message || "Unlock failed"),
  });

  const hasMore = rows.length === limit;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </Button>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Entity</th>
                <th className="text-left px-3 py-2">Field</th>
                <th className="text-left px-3 py-2">Value</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-left px-3 py-2">Locked by</th>
                <th className="text-left px-3 py-2">Locked</th>
                {isAdminOrAbove && <th className="text-right px-3 py-2">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && [...Array(4)].map((_, i) => (
                <tr key={i}><td colSpan={7} className="p-3"><Skeleton className="h-6 w-full" /></td></tr>
              ))}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-10 text-center text-muted-foreground">
                  <LockOpen className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No locked fields.
                </td></tr>
              )}
              {rows.map(r => (
                <tr key={r.source_id} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <div className="font-medium truncate max-w-[180px]">{r.entity_name || r.entity_id}</div>
                    <div className="text-[10px] text-muted-foreground capitalize">{r.entity_type}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">{r.field_name}</td>
                  <td className="px-3 py-2 truncate max-w-[200px]">{r.value || "—"}</td>
                  <td className="px-3 py-2"><FieldSourceChip source={r.source} size="xs" /></td>
                  <td className="px-3 py-2">{r.locked_by_email || <span className="text-muted-foreground italic">system</span>}</td>
                  <td className="px-3 py-2" title={fmtAbs(r.locked_at)}>{fmtRel(r.locked_at)}</td>
                  {isAdminOrAbove && (
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                        onClick={() => unlockMut.mutate({ entity_type: r.entity_type, entity_id: r.entity_id, field_name: r.field_name })}
                        disabled={unlockMut.isPending}>
                        <LockOpen className="h-3 w-3 mr-1" />
                        Unlock
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Paginator
        offset={offset}
        limit={limit}
        hasMore={hasMore}
        onPrev={() => setOffset(Math.max(0, offset - limit))}
        onNext={() => setOffset(offset + limit)}
      />
    </div>
  );
}

// ── Recent changes tab ───────────────────────────────────────────────────

function RecentChangesTab() {
  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["safr", "recent_changes"],
    queryFn: async () => {
      const client = api._supabase;
      const { data, error } = await client
        .from("pulse_timeline")
        .select("id, entity_type, pulse_entity_id, event_type, title, description, previous_value, new_value, source, created_at")
        .in("event_type", ["field_promoted", "field_locked", "field_unlocked", "field_dismissed"])
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 30 * 1000,
  });

  const eventLabel = (ev) => ({
    field_promoted: "Promoted",
    field_locked:   "Locked",
    field_unlocked: "Unlocked",
    field_dismissed:"Dismissed",
  })[ev] || ev;

  const eventVariant = (ev) => ({
    field_promoted: "default",
    field_locked:   "secondary",
    field_unlocked: "outline",
    field_dismissed:"destructive",
  })[ev] || "outline";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {isLoading && [...Array(6)].map((_, i) => (
              <li key={i} className="p-3"><Skeleton className="h-6 w-full" /></li>
            ))}
            {!isLoading && rows.length === 0 && (
              <li className="p-10 text-center text-muted-foreground text-xs">
                <History className="h-8 w-8 mx-auto mb-2 opacity-40" />
                No recent field changes.
              </li>
            )}
            {rows.map(r => {
              const oldVal = r.previous_value?.display || r.previous_value?.value || r.previous_value?.text || (typeof r.previous_value === "string" ? r.previous_value : null);
              const newVal = r.new_value?.display || r.new_value?.value || r.new_value?.text || (typeof r.new_value === "string" ? r.new_value : null);
              const fieldName = r.new_value?.field_name || r.previous_value?.field_name || null;
              return (
                <li key={r.id} className="p-3 flex items-start gap-3 text-xs hover:bg-muted/30">
                  <Badge variant={eventVariant(r.event_type)} className="text-[10px] shrink-0">
                    {eventLabel(r.event_type)}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate max-w-[220px]">{r.title || r.entity_type}</span>
                      {fieldName && <span className="font-mono text-[10px] text-muted-foreground">{fieldName}</span>}
                      {r.source && <FieldSourceChip source={r.source} size="xs" />}
                    </div>
                    {(oldVal || newVal) && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {oldVal && <span className="text-muted-foreground line-through truncate max-w-[160px]">{String(oldVal)}</span>}
                        {oldVal && newVal && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                        {newVal && <span className="truncate max-w-[200px]">{String(newVal)}</span>}
                      </div>
                    )}
                    {r.description && !oldVal && !newVal && (
                      <div className="text-muted-foreground mt-0.5">{r.description}</div>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap" title={fmtAbs(r.created_at)}>
                    {fmtRel(r.created_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Substrate invalidation diagnostics ────────────────────────────────────
// Feeds off pulse_get_substrate_invalidation_stats() (migration 193) to show
// how many Market Share / Retention substrate rows are stale, WHY they went
// stale, when the compute cron last drained the queue, and a rough ETA.

const INVALIDATION_REASON_LABELS = {
  matrix_change:        "Price matrix edits",
  package_change:       "Package tier edits",
  product_change:       "Product tier edits",
  project_change:       "Projects INSERT/UPDATE",
  listing_change:       "Listing media/price",
  linked_entity_change: "CRM linking",
  captured_drift:       "Capture drift retro-fill",
  manual:               "Manual trigger",
  unspecified:          "Legacy / unspecified",
};

function SubstrateInvalidationPanel() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["substrate-invalidation-stats"],
    queryFn: () => api.rpc("pulse_get_substrate_invalidation_stats"),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });

  const stale = Number(data?.stale_total ?? 0);
  const breakdown = data?.quote_status_breakdown || {};
  const fresh = Number(breakdown.fresh ?? 0);
  const pending = Number(breakdown.pending_enrichment ?? 0);
  const dataGap = Number(breakdown.data_gap ?? 0);
  const byReason = data?.stale_by_reason || {};
  const lastDrain = data?.last_cron_drain_at;
  const oldestStale = data?.oldest_stale_computed_at;
  const etaMin = Number(data?.backlog_eta_minutes ?? 0);

  return (
    <Card className="border-l-4 border-l-amber-500/60">
      <CardContent className="pt-5 pb-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Gauge className="h-4 w-4 text-amber-600" />
              Market Share substrate
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              pulse_listing_missed_opportunity — cache driving Market Share + Client Retention.
              Cron <code className="text-[10px] bg-muted px-1 rounded">pulse-compute-stale-quotes</code> drains staleness every 10min.
            </p>
          </div>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Fresh</div>
            <div className="text-base font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {isLoading ? <Skeleton className="h-5 w-10" /> : fresh.toLocaleString()}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Stale (backlog)</div>
            <div className="text-base font-semibold tabular-nums text-amber-600 dark:text-amber-400">
              {isLoading ? <Skeleton className="h-5 w-10" /> : stale.toLocaleString()}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending enrichment</div>
            <div className="text-base font-semibold tabular-nums text-muted-foreground">
              {isLoading ? <Skeleton className="h-5 w-10" /> : pending.toLocaleString()}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Data gap</div>
            <div className="text-base font-semibold tabular-nums text-muted-foreground">
              {isLoading ? <Skeleton className="h-5 w-10" /> : dataGap.toLocaleString()}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Timer className="h-3 w-3" /> Backlog ETA
            </div>
            <div className="text-base font-semibold tabular-nums">
              {isLoading ? <Skeleton className="h-5 w-10" />
                : etaMin === 0 ? "—" : `~${etaMin}m`}
            </div>
          </div>
        </div>

        {stale > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
              Stale by reason
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(byReason).map(([key, count]) => {
                const n = Number(count || 0);
                if (n === 0) return null;
                return (
                  <Badge key={key} variant="outline" className="text-[10px] font-normal">
                    {INVALIDATION_REASON_LABELS[key] || key}
                    <span className="ml-1.5 font-semibold tabular-nums">{n.toLocaleString()}</span>
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground pt-1 border-t">
          <span>
            Last cron drain:{" "}
            <span className="font-medium text-foreground">
              {lastDrain ? fmtRel(lastDrain) : "—"}
            </span>
          </span>
          {oldestStale && (
            <span>
              Oldest stale row:{" "}
              <span className="font-medium text-foreground">{fmtRel(oldestStale)}</span>
            </span>
          )}
          {data?.generated_at && (
            <span>
              Generated: <span className="font-medium text-foreground">{fmtRel(data.generated_at)}</span>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────

export default function SettingsDataConsistency() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 lg:p-8 space-y-6 max-w-7xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Data Consistency
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Source-Aware Field Resolution: surface conflicts where automated
            sources disagree, user locks freezing auto-updates, and recent
            promotion events across every tracked entity.
          </p>
        </div>

        <StatsStrip />

        <SubstrateInvalidationPanel />

        <Tabs defaultValue="conflicts" className="space-y-4">
          <TabsList>
            <TabsTrigger value="conflicts" className="gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Conflicts
            </TabsTrigger>
            <TabsTrigger value="locked" className="gap-1.5">
              <Lock className="h-3.5 w-3.5" />
              Locked fields
            </TabsTrigger>
            <TabsTrigger value="recent" className="gap-1.5">
              <History className="h-3.5 w-3.5" />
              Recent changes
            </TabsTrigger>
          </TabsList>
          <TabsContent value="conflicts"><ConflictsTab /></TabsContent>
          <TabsContent value="locked"><LockedFieldsTab /></TabsContent>
          <TabsContent value="recent"><RecentChangesTab /></TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}

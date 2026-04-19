/**
 * SettingsLegacyCrmReconciliation.jsx
 *
 * Admin page for reviewing how imported legacy_projects (currently 3,480
 * Pipedrive historicals) are attributed back to the PULSE LAYER
 * (pulse_agents + pulse_agencies) — not directly to CRM. CRM membership
 * flows through automatically when a pulse entity is promoted via the
 * Mappings tab (see migration 198).
 *
 * Two-pass linkage (migration 198):
 *   - property_chain_pulse: legacy row's property_key matches a
 *                           pulse_listings row whose agent_pulse_id /
 *                           agency_pulse_id resolve deterministically.
 *                           Confidence 0.95.
 *   - fuzzy_name_pulse:     pg_trgm similarity on raw agent_name / agency_name
 *                           against pulse_agents.full_name / pulse_agencies.name
 *                           (8,810 + 2,557 candidates — 280x broader than CRM).
 *                           Auto-link above threshold + next-candidate gap.
 *
 * Data sources (all RPCs from migration 198):
 *   - legacy_reconciliation_stats()
 *   - legacy_reconciliation_review(filter, search, limit, offset)
 *   - legacy_reconciliation_apply_manual(legacy_id, pulse_agent_id, pulse_agency_id, reviewer)
 *   - legacy_reconciliation_apply_threshold(min_confidence, reviewer)
 *   - legacy_reconcile_all_pulse(auto_threshold)  for "Re-run reconciliation"
 *
 * Permission: admin and above.
 */

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Database, CheckCircle2, AlertTriangle, RefreshCw, Zap,
  Loader2, Search, Link2, UserCheck, Building2, X, Crown,
} from "lucide-react";

// Helpers

const NUM = (n) => Number(n || 0).toLocaleString();

function confidenceTone(c) {
  const v = Number(c || 0);
  if (v >= 0.85) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 0.7)  return "text-blue-600 dark:text-blue-400";
  if (v >= 0.4)  return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function ConfidencePct({ value }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  const v = Number(value);
  const pct = Math.round(v * 100);
  return (
    <span className={`text-xs tabular-nums font-medium ${confidenceTone(v)}`}>
      {pct}%
    </span>
  );
}

// Stat strip

function StatCard({ icon: Icon, label, value, loading, tone = "default" }) {
  const tones = {
    default: "text-foreground",
    warning: "text-amber-600 dark:text-amber-400",
    success: "text-emerald-600 dark:text-emerald-400",
    info:    "text-blue-600 dark:text-blue-400",
    danger:  "text-red-600 dark:text-red-400",
  };
  return (
    <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
      <div className={`rounded-md bg-muted p-2 ${tones[tone]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold tabular-nums ${tones[tone]}`}>
          {loading ? <Skeleton className="h-6 w-12" /> : NUM(value)}
        </div>
      </div>
    </div>
  );
}

function StatsStrip({ stats, isLoading }) {
  const total = stats?.total ?? 0;
  const unlinked = stats?.unlinked ?? 0;
  const linkedPct = total > 0 ? Math.round(100 * (total - unlinked) / total) : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      <StatCard icon={Database}     label="Total legacy"   value={stats?.total}        loading={isLoading} />
      <StatCard icon={CheckCircle2} label="Fully linked"   value={stats?.fully_linked} loading={isLoading} tone="success" />
      <StatCard icon={UserCheck}    label="Agent linked"   value={(stats?.fully_linked || 0) + (stats?.agent_only || 0)} loading={isLoading} tone="info" />
      <StatCard icon={Building2}    label="Agency linked"  value={(stats?.fully_linked || 0) + (stats?.agency_only || 0)} loading={isLoading} tone="info" />
      <StatCard icon={AlertTriangle} label="Unlinked"      value={stats?.unlinked}     loading={isLoading} tone="warning" />
      <StatCard icon={Zap}           label="Coverage %"    value={linkedPct}           loading={isLoading} tone="success" />
    </div>
  );
}

// Filters

const FILTER_OPTIONS = [
  { value: "unlinked",    label: "Unlinked" },
  { value: "agent_only",  label: "Agent linked, agency missing" },
  { value: "agency_only", label: "Agency linked, agent missing" },
  { value: "linked",      label: "Fully linked" },
  { value: "all",         label: "All rows" },
];

function FiltersBar({
  filter, setFilter, search, setSearch,
  onReRun, reRunning, onBulkApply, bulkThreshold, setBulkThreshold, bulkApplying,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={filter} onValueChange={setFilter}>
        <SelectTrigger className="w-[260px] h-9"><SelectValue /></SelectTrigger>
        <SelectContent>
          {FILTER_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative flex-1 min-w-[220px] max-w-[420px]">
        <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search address, agent, agency, or email..."
          className="pl-8 h-9"
        />
      </div>

      <div className="flex items-center gap-1 ml-auto">
        <label className="text-xs text-muted-foreground whitespace-nowrap">
          Apply ≥
        </label>
        <Input
          type="number" min="0.5" max="1" step="0.05"
          value={bulkThreshold}
          onChange={(e) => setBulkThreshold(e.target.value)}
          className="w-20 h-9"
        />
        <Button
          variant="secondary" size="sm" className="h-9"
          onClick={onBulkApply} disabled={bulkApplying}
          title="Mark every pulse-layer match at or above this confidence as reviewed"
        >
          {bulkApplying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
          Bulk confirm
        </Button>
        <Button variant="outline" size="sm" className="h-9" onClick={onReRun} disabled={reRunning}>
          {reRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
          Re-run reconciliation
        </Button>
      </div>
    </div>
  );
}

// Review table

function InCrmChip({ inCrm }) {
  if (!inCrm) return null;
  return (
    <Badge variant="secondary" className="text-[10px] gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
      <Crown className="h-2.5 w-2.5" />
      in CRM
    </Badge>
  );
}

function CandidateList({ candidates, onPick }) {
  if (!candidates || candidates.length === 0) {
    return <span className="text-xs text-muted-foreground">No pulse matches</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {candidates.slice(0, 3).map((c, i) => (
        <div key={c.id} className="flex items-center gap-2 text-xs">
          <ConfidencePct value={c.score} />
          <span className={`truncate max-w-[160px] ${i === 0 ? "font-medium" : "text-muted-foreground"}`} title={c.name}>
            {c.name}
          </span>
          <InCrmChip inCrm={c.is_in_crm} />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs ml-auto"
            onClick={() => onPick(c)}
          >
            Pick
          </Button>
        </div>
      ))}
    </div>
  );
}

function ReviewTable({ rows, loading, onApply, onReject }) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return <div className="p-8 text-center text-sm text-muted-foreground">No rows match the current filter.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[240px]">Legacy row</TableHead>
          <TableHead className="w-[260px]">Suggested pulse agents</TableHead>
          <TableHead className="w-[260px]">Suggested pulse agencies</TableHead>
          <TableHead>Current linkage</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="align-top">
              <div className="text-xs font-mono truncate max-w-[240px]" title={r.raw_address}>
                {r.raw_address || <span className="italic">(no address)</span>}
              </div>
              <div className="text-xs text-muted-foreground mt-1 truncate max-w-[240px]" title={r.agent_name}>
                Agent: <span className="font-medium text-foreground">{r.agent_name || "—"}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate max-w-[240px]" title={r.agency_name}>
                Agency: <span className="font-medium text-foreground">{r.agency_name || "—"}</span>
              </div>
              {r.client_email && (
                <div className="text-[10px] text-muted-foreground truncate max-w-[240px]" title={r.client_email}>
                  {r.client_email}
                </div>
              )}
            </TableCell>
            <TableCell className="align-top">
              <CandidateList
                candidates={r.candidate_agents}
                onPick={(c) => onApply(r, { pulse_agent_id: c.id })}
              />
            </TableCell>
            <TableCell className="align-top">
              <CandidateList
                candidates={r.candidate_agencies}
                onPick={(c) => onApply(r, { pulse_agency_id: c.id })}
              />
            </TableCell>
            <TableCell className="align-top">
              <div className="flex flex-col gap-1 text-xs">
                {r.linked_pulse_agent_id ? (
                  <div className="flex items-center gap-2">
                    <Link2 className="h-3 w-3 text-emerald-600" />
                    <span className="truncate max-w-[160px]" title={r.linked_pulse_agent_name}>
                      {r.linked_pulse_agent_name || "pulse agent"}
                    </span>
                    <ConfidencePct value={r.pulse_agent_linkage_confidence} />
                    <Badge variant="outline" className="text-[10px]">{r.pulse_agent_linkage_source || "—"}</Badge>
                    <InCrmChip inCrm={r.agent_in_crm} />
                  </div>
                ) : (
                  <span className="text-muted-foreground">agent: unlinked</span>
                )}
                {r.linked_pulse_agency_id ? (
                  <div className="flex items-center gap-2">
                    <Link2 className="h-3 w-3 text-emerald-600" />
                    <span className="truncate max-w-[160px]" title={r.linked_pulse_agency_name}>
                      {r.linked_pulse_agency_name || "pulse agency"}
                    </span>
                    <ConfidencePct value={r.pulse_agency_linkage_confidence} />
                    <Badge variant="outline" className="text-[10px]">{r.pulse_agency_linkage_source || "—"}</Badge>
                    <InCrmChip inCrm={r.agency_in_crm} />
                  </div>
                ) : (
                  <span className="text-muted-foreground">agency: unlinked</span>
                )}
              </div>
            </TableCell>
            <TableCell className="align-top text-right space-x-1 whitespace-nowrap">
              {(r.candidate_agents?.[0] || r.candidate_agencies?.[0]) && (
                <Button
                  variant="default" size="sm" className="h-7 px-2 text-xs"
                  onClick={() => onApply(r, {
                    pulse_agent_id:  r.candidate_agents?.[0]?.id || null,
                    pulse_agency_id: r.candidate_agencies?.[0]?.id || null,
                  })}
                >
                  Confirm top
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onReject(r)}>
                Reject
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Main page

export default function SettingsLegacyCrmReconciliation() {
  const qc = useQueryClient();
  const { data: user } = useCurrentUser();
  const [filter, setFilter]   = useState("unlinked");
  const [search, setSearch]   = useState("");
  const [page, setPage]       = useState(0);
  const [bulkThreshold, setBulkThreshold] = useState("0.85");
  const limit = 50;

  const statsQ = useQuery({
    queryKey: ["legacy-pulse-stats"],
    queryFn: () => api.rpc("legacy_reconciliation_stats"),
  });

  const reviewQ = useQuery({
    queryKey: ["legacy-pulse-review", filter, search, page],
    queryFn: () => api.rpc("legacy_reconciliation_review", {
      p_filter: filter,
      p_search: search || null,
      p_limit:  limit,
      p_offset: page * limit,
    }),
  });

  const reconcileMut = useMutation({
    mutationFn: () => api.rpc("legacy_reconcile_all_pulse", { p_auto_threshold: 0.85 }),
    onSuccess: (res) => {
      const c = res?.combined || {};
      toast.success(`Linked ${NUM(c.linked_agent_total)} pulse agents + ${NUM(c.linked_agency_total)} pulse agencies`);
      qc.invalidateQueries({ queryKey: ["legacy-pulse-stats"] });
      qc.invalidateQueries({ queryKey: ["legacy-pulse-review"] });
    },
    onError: (err) => toast.error(err?.message || "Reconciliation failed"),
  });

  const bulkMut = useMutation({
    mutationFn: () => api.rpc("legacy_reconciliation_apply_threshold", {
      p_min_confidence: parseFloat(bulkThreshold) || 0.85,
      p_reviewer:       user?.id || null,
    }),
    onSuccess: (res) => {
      toast.success(`Marked ${NUM(res?.marked_reviewed || 0)} rows as reviewed`);
      qc.invalidateQueries({ queryKey: ["legacy-pulse-stats"] });
      qc.invalidateQueries({ queryKey: ["legacy-pulse-review"] });
    },
    onError: (err) => toast.error(err?.message || "Bulk apply failed"),
  });

  const applyMut = useMutation({
    mutationFn: ({ legacyId, pulseAgentId, pulseAgencyId }) => api.rpc("legacy_reconciliation_apply_manual", {
      p_legacy_id:  legacyId,
      p_contact_id: pulseAgentId  || null,
      p_agency_id:  pulseAgencyId || null,
      p_reviewer:   user?.id || null,
    }),
    onSuccess: () => {
      toast.success("Pulse-layer linkage applied");
      qc.invalidateQueries({ queryKey: ["legacy-pulse-stats"] });
      qc.invalidateQueries({ queryKey: ["legacy-pulse-review"] });
    },
    onError: (err) => toast.error(err?.message || "Apply failed"),
  });

  const rejectMut = useMutation({
    mutationFn: (legacyId) => api.rpc("legacy_reconciliation_apply_manual", {
      p_legacy_id:  legacyId,
      p_contact_id: null,
      p_agency_id:  null,
      p_reviewer:   user?.id || null,
    }),
    onSuccess: () => {
      toast.success("Marked as reviewed (no change)");
      qc.invalidateQueries({ queryKey: ["legacy-pulse-review"] });
    },
  });

  const rows = reviewQ.data?.rows || [];

  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 lg:p-8 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Link2 className="h-7 w-7 text-primary" />
            Legacy Pulse Reconciliation
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl">
            Link imported historical projects to the REA-scraped pulse
            agents/agencies (8,810 + 2,557 candidates). CRM membership flows
            through automatically when a pulse entity is promoted via the
            Mappings tab — no re-reconciliation needed. The engine auto-links
            via property-chain (near-deterministic, confidence 0.95) then
            falls back to fuzzy name matching with a runner-up gap guard.
            Anything below the auto-confirm threshold surfaces here.
          </p>
        </div>

        <StatsStrip stats={statsQ.data} isLoading={statsQ.isLoading} />

        <Card className="p-4">
          <FiltersBar
            filter={filter}
            setFilter={(f) => { setFilter(f); setPage(0); }}
            search={search}
            setSearch={(s) => { setSearch(s); setPage(0); }}
            onReRun={() => reconcileMut.mutate()}
            reRunning={reconcileMut.isPending}
            bulkThreshold={bulkThreshold}
            setBulkThreshold={setBulkThreshold}
            onBulkApply={() => bulkMut.mutate()}
            bulkApplying={bulkMut.isPending}
          />
        </Card>

        <Card className="overflow-hidden">
          <ReviewTable
            rows={rows}
            loading={reviewQ.isLoading}
            onApply={(row, picks) => applyMut.mutate({
              legacyId:       row.id,
              pulseAgentId:   picks.pulse_agent_id,
              pulseAgencyId:  picks.pulse_agency_id,
            })}
            onReject={(row) => rejectMut.mutate(row.id)}
          />
          {rows.length === limit && (
            <div className="flex justify-between items-center p-3 border-t">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page + 1}</span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </Card>
      </div>
    </PermissionGuard>
  );
}

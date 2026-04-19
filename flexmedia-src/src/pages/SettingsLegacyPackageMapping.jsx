/**
 * SettingsLegacyPackageMapping.jsx
 *
 * Admin page for reviewing and confirming how raw `package_name_legacy`
 * values coming out of Pipedrive (or any other legacy source) map onto
 * the canonical 6-package FlexStudios catalog.
 *
 * Data sources (all RPCs, all defined in migration 185):
 *   - legacy_package_mapping_stats()           — stat strip counts
 *   - legacy_package_mapping_review(...)       — grouped review queue
 *   - legacy_map_package(raw, source_hint)     — on-demand single match
 *   - legacy_map_packages_batch(batch, limit)  — re-run auto-mapping
 *   - legacy_package_apply_override(...)       — admin confirms a mapping
 *
 * Permission: admin and above (enforced via ROUTE_ACCESS + PermissionGuard).
 */

import React, { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useEntityList } from "@/components/hooks/useEntityData";
import {
  Database, CheckCircle2, AlertTriangle, HelpCircle, RefreshCw, Plus,
  Package as PackageIcon, Loader2, Search, Zap,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const NUM = (n) => Number(n || 0).toLocaleString();

function confidenceTone(c) {
  const v = Number(c || 0);
  if (v >= 0.85) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 0.7)  return "text-blue-600 dark:text-blue-400";
  if (v >= 0.4)  return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function ConfidenceBadge({ value }) {
  if (value == null) return <Badge variant="outline" className="text-xs">—</Badge>;
  const v = Number(value);
  const pct = Math.round(v * 100);
  const tone = v >= 0.85 ? "default"
    : v >= 0.7 ? "secondary"
    : v >= 0.4 ? "outline"
    : "destructive";
  return <Badge variant={tone} className={`text-xs tabular-nums ${confidenceTone(v)}`}>{pct}%</Badge>;
}

// ─────────────────────────────────────────────────────────────────────────
// Stat strip
// ─────────────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, loading, tone = "default" }) {
  const toneClasses = {
    default: "text-foreground",
    warning: "text-amber-600 dark:text-amber-400",
    success: "text-emerald-600 dark:text-emerald-400",
    info:    "text-blue-600 dark:text-blue-400",
    danger:  "text-red-600 dark:text-red-400",
  };
  return (
    <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
      <div className={`rounded-md bg-muted p-2 ${toneClasses[tone]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold tabular-nums ${toneClasses[tone]}`}>
          {loading ? <Skeleton className="h-6 w-12" /> : NUM(value)}
        </div>
      </div>
    </div>
  );
}

function StatsStrip({ stats, isLoading }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <StatCard icon={Database}      label="Total legacy"   value={stats?.total}         loading={isLoading} />
      <StatCard icon={CheckCircle2}  label="Mapped (auto)"  value={stats?.mapped_auto}   loading={isLoading} tone="info" />
      <StatCard icon={CheckCircle2}  label="Mapped (manual)"value={stats?.mapped_manual} loading={isLoading} tone="success" />
      <StatCard icon={AlertTriangle} label="Unmapped"       value={stats?.unmapped}      loading={isLoading} tone="warning" />
      <StatCard icon={HelpCircle}    label="Ambiguous"      value={stats?.ambiguous}     loading={isLoading} tone="danger" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "unmapped",        label: "Unmapped" },
  { value: "low_confidence",  label: "Low confidence" },
  { value: "auto",            label: "Auto-mapped" },
  { value: "manual",          label: "Manually confirmed" },
  { value: "all",             label: "All rows" },
];

function FiltersBar({ status, setStatus, search, setSearch, onReRun, reRunning }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-[200px] h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative flex-1 min-w-[200px] max-w-[360px]">
        <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search raw package name..."
          className="pl-8 h-9"
        />
      </div>

      <Button variant="outline" size="sm" className="h-9" onClick={onReRun} disabled={reRunning}>
        {reRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
        Re-run mapping
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Manual-override modal
// ─────────────────────────────────────────────────────────────────────────

function OverrideModal({ open, onOpenChange, row, packages, onSaved }) {
  const [pkgId, setPkgId] = useState(row?.mapped_package_id || "");
  const [tier, setTier]   = useState(row?.mapped_package_tier || "standard");
  const [createAlias, setCreateAlias] = useState(true);

  React.useEffect(() => {
    if (row) {
      setPkgId(row.mapped_package_id || "");
      setTier(row.mapped_package_tier || "standard");
      setCreateAlias(true);
    }
  }, [row]);

  const saveMut = useMutation({
    mutationFn: async () => {
      return api.rpc("legacy_package_apply_override", {
        p_raw_name:     row.raw_name,
        p_package_id:   pkgId,
        p_tier:         tier,
        p_create_alias: createAlias,
        p_source_hint:  null,
      });
    },
    onSuccess: (res) => {
      toast.success(`Applied to ${res?.updated_rows || 0} rows`);
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err) => toast.error(err?.message || "Override failed"),
  });

  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Override package mapping</DialogTitle>
          <DialogDescription>
            Apply the selected canonical package + tier to every legacy row
            whose raw name equals &quot;{row.raw_name}&quot;.
            {" "}({NUM(row.row_count)} row{row.row_count === 1 ? "" : "s"})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Canonical package
            </label>
            <Select value={pkgId} onValueChange={setPkgId}>
              <SelectTrigger><SelectValue placeholder="Choose package..." /></SelectTrigger>
              <SelectContent>
                {(packages || []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Tier
            </label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="premium">Premium</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={createAlias}
              onChange={(e) => setCreateAlias(e.target.checked)}
            />
            <span>Create alias rule so future imports match automatically</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => saveMut.mutate()} disabled={!pkgId || saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Apply override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Add-alias modal
// ─────────────────────────────────────────────────────────────────────────

function AddAliasModal({ open, onOpenChange, packages, onSaved }) {
  const [form, setForm] = useState({
    alias_pattern: "",
    match_mode:    "contains",
    canonical_package_id: "",
    canonical_tier: "standard",
    confidence:     "0.9",
    source_hint:    "",
    notes:          "",
  });

  React.useEffect(() => {
    if (open) {
      setForm({
        alias_pattern: "",
        match_mode:    "contains",
        canonical_package_id: "",
        canonical_tier: "standard",
        confidence:     "0.9",
        source_hint:    "",
        notes:          "",
      });
    }
  }, [open]);

  const saveMut = useMutation({
    mutationFn: async () => {
      return api.entities.LegacyPackageAlias.create({
        alias_pattern:        form.alias_pattern.trim(),
        match_mode:           form.match_mode,
        canonical_package_id: form.canonical_package_id,
        canonical_tier:       form.canonical_tier,
        confidence:           parseFloat(form.confidence) || 0.9,
        source_hint:          form.source_hint || null,
        notes:                form.notes || null,
      });
    },
    onSuccess: () => {
      toast.success("Alias rule added");
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err) => toast.error(err?.message || "Failed to save alias"),
  });

  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add alias rule</DialogTitle>
          <DialogDescription>
            Teach the matcher that a raw legacy name maps to a canonical
            package. Used by future imports and when you hit &quot;Re-run mapping&quot;.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Alias pattern
            </label>
            <Input
              value={form.alias_pattern}
              onChange={(e) => set("alias_pattern", e.target.value)}
              placeholder="e.g. premium silver, gold plus, dusk vid"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Match mode
            </label>
            <Select value={form.match_mode} onValueChange={(v) => set("match_mode", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="exact">Exact</SelectItem>
                <SelectItem value="prefix">Prefix</SelectItem>
                <SelectItem value="contains">Contains</SelectItem>
                <SelectItem value="regex">Regex</SelectItem>
                <SelectItem value="fuzzy">Fuzzy</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Confidence (0-1)
            </label>
            <Input
              type="number"
              min="0" max="1" step="0.05"
              value={form.confidence}
              onChange={(e) => set("confidence", e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Canonical package
            </label>
            <Select value={form.canonical_package_id} onValueChange={(v) => set("canonical_package_id", v)}>
              <SelectTrigger><SelectValue placeholder="Choose..." /></SelectTrigger>
              <SelectContent>
                {(packages || []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Tier
            </label>
            <Select value={form.canonical_tier} onValueChange={(v) => set("canonical_tier", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="premium">Premium</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Source hint (optional — scopes this alias to one import source)
            </label>
            <Input
              value={form.source_hint}
              onChange={(e) => set("source_hint", e.target.value)}
              placeholder="e.g. pipedrive"
            />
          </div>

          <div className="col-span-2">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Notes (optional)
            </label>
            <Input
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={!form.alias_pattern.trim() || !form.canonical_package_id || saveMut.isPending}
          >
            {saveMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save alias
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Review table
// ─────────────────────────────────────────────────────────────────────────

function ReviewTable({ rows, loading, packages, onOverride, onApply }) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No rows match the current filters.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Raw legacy name</TableHead>
          <TableHead className="text-right">Count</TableHead>
          <TableHead>Suggested mapping</TableHead>
          <TableHead>Tier</TableHead>
          <TableHead>Confidence</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.raw_name}>
            <TableCell className="font-mono text-xs max-w-[280px] truncate" title={r.raw_name}>
              {r.raw_name || <span className="italic text-muted-foreground">(empty)</span>}
            </TableCell>
            <TableCell className="text-right tabular-nums">{NUM(r.row_count)}</TableCell>
            <TableCell>
              {r.mapped_package_name
                ? <span className="flex items-center gap-1.5">
                    <PackageIcon className="h-3 w-3 text-muted-foreground" />
                    {r.mapped_package_name}
                  </span>
                : <span className="text-xs text-muted-foreground">—</span>
              }
            </TableCell>
            <TableCell>
              {r.mapped_package_tier
                ? <Badge variant="outline" className="text-[10px] uppercase">{r.mapped_package_tier}</Badge>
                : <span className="text-xs text-muted-foreground">—</span>
              }
            </TableCell>
            <TableCell><ConfidenceBadge value={r.confidence} /></TableCell>
            <TableCell>
              <span className="text-xs text-muted-foreground">{r.mapping_source || "—"}</span>
            </TableCell>
            <TableCell className="text-right space-x-1">
              {r.mapped_package_id && r.mapping_source === "auto_fuzzy" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onApply(r)}
                  title="Confirm the current auto-suggestion and lock it in"
                >
                  Confirm
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onOverride(r)}
              >
                Override
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────

function Page() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("unmapped");
  const [search, setSearch] = useState("");
  const [bulkThreshold, setBulkThreshold] = useState(0.85);
  const [overrideRow, setOverrideRow]   = useState(null);
  const [aliasOpen, setAliasOpen]       = useState(false);

  // Canonical package list for dropdowns
  const { data: packages } = useEntityList("Package", "name", 100);

  const { data: statsRes, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ["legacy_pkg_map", "stats"],
    queryFn: () => api.rpc("legacy_package_mapping_stats"),
    staleTime: 30 * 1000,
  });

  const { data: reviewRes, isLoading: reviewLoading, refetch: refetchReview } = useQuery({
    queryKey: ["legacy_pkg_map", "review", status, search],
    queryFn: () => api.rpc("legacy_package_mapping_review", {
      p_status:   status,
      p_batch_id: null,
      p_search:   search || null,
      p_limit:    200,
      p_offset:   0,
    }),
    staleTime: 15 * 1000,
  });

  const rows = Array.isArray(reviewRes?.rows) ? reviewRes.rows : [];
  const tableExists = statsRes?.table_exists !== false;

  const reRunMut = useMutation({
    mutationFn: () => api.rpc("legacy_map_packages_batch", { p_batch_id: null, p_limit: 500 }),
    onSuccess: (res) => {
      toast.success(
        `Attempted ${NUM(res?.attempted)} · mapped ${NUM(res?.mapped)} · unmapped ${NUM(res?.unmapped)}`
      );
      qc.invalidateQueries({ queryKey: ["legacy_pkg_map"] });
    },
    onError: (err) => toast.error(err?.message || "Re-run failed"),
  });

  const bulkApplyMut = useMutation({
    mutationFn: async (threshold) => {
      const eligible = rows.filter((r) =>
        r.mapped_package_id
        && r.mapping_source === "auto_fuzzy"
        && Number(r.confidence) >= threshold
      );
      let ok = 0;
      for (const r of eligible) {
        try {
          await api.rpc("legacy_package_apply_override", {
            p_raw_name:     r.raw_name,
            p_package_id:   r.mapped_package_id,
            p_tier:         r.mapped_package_tier,
            p_create_alias: true,
            p_source_hint:  null,
          });
          ok += 1;
        } catch (err) {
          console.warn("bulk apply failed for", r.raw_name, err);
        }
      }
      return { ok, total: eligible.length };
    },
    onSuccess: ({ ok, total }) => {
      toast.success(`Applied ${ok}/${total} suggestions`);
      qc.invalidateQueries({ queryKey: ["legacy_pkg_map"] });
    },
    onError: (err) => toast.error(err?.message || "Bulk apply failed"),
  });

  const applyOne = useMutation({
    mutationFn: (row) => api.rpc("legacy_package_apply_override", {
      p_raw_name:     row.raw_name,
      p_package_id:   row.mapped_package_id,
      p_tier:         row.mapped_package_tier,
      p_create_alias: true,
      p_source_hint:  null,
    }),
    onSuccess: (res) => {
      toast.success(`Confirmed — ${NUM(res?.updated_rows)} rows updated`);
      qc.invalidateQueries({ queryKey: ["legacy_pkg_map"] });
    },
    onError: (err) => toast.error(err?.message || "Apply failed"),
  });

  const bulkCountPreview = useMemo(
    () => rows.filter((r) =>
      r.mapped_package_id
      && r.mapping_source === "auto_fuzzy"
      && Number(r.confidence) >= bulkThreshold
    ).length,
    [rows, bulkThreshold]
  );

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Legacy Package Mapping</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Reviews how imported package names (Pipedrive, CSVs, older CRMs) are
            matched to the canonical FlexStudios catalog. Auto-mapping runs every
            5 minutes; use this page to confirm, override, or add new alias rules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { refetchStats(); refetchReview(); }}>
            <RefreshCw className="h-4 w-4 mr-2" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setAliasOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add alias rule
          </Button>
        </div>
      </div>

      {!tableExists && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium">legacy_projects table not yet created</div>
              <div className="text-muted-foreground">
                The sibling import agent hasn&apos;t deployed their migration yet. The
                mapping dictionary + matcher RPCs are live and ready — as soon as
                legacy rows land, they will start auto-mapping on the 5-minute cron.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <StatsStrip stats={statsRes} isLoading={statsLoading} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Review queue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <FiltersBar
            status={status}
            setStatus={setStatus}
            search={search}
            setSearch={setSearch}
            onReRun={() => reRunMut.mutate()}
            reRunning={reRunMut.isPending}
          />

          <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/40 p-2">
            <span className="text-xs text-muted-foreground">Bulk apply suggestions with confidence ≥</span>
            <Input
              type="number" min="0" max="1" step="0.05"
              value={bulkThreshold}
              onChange={(e) => setBulkThreshold(parseFloat(e.target.value) || 0)}
              className="h-7 w-20 text-xs"
            />
            <Badge variant="outline" className="text-xs">
              {bulkCountPreview} match{bulkCountPreview === 1 ? "" : "es"} in view
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs ml-auto"
              disabled={bulkCountPreview === 0 || bulkApplyMut.isPending}
              onClick={() => bulkApplyMut.mutate(bulkThreshold)}
            >
              {bulkApplyMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              Apply all suggestions
            </Button>
          </div>

          <ReviewTable
            rows={rows}
            loading={reviewLoading}
            packages={packages}
            onOverride={setOverrideRow}
            onApply={(r) => applyOne.mutate(r)}
          />
        </CardContent>
      </Card>

      <OverrideModal
        open={!!overrideRow}
        onOpenChange={(v) => !v && setOverrideRow(null)}
        row={overrideRow}
        packages={packages}
        onSaved={() => qc.invalidateQueries({ queryKey: ["legacy_pkg_map"] })}
      />

      <AddAliasModal
        open={aliasOpen}
        onOpenChange={setAliasOpen}
        packages={packages}
        onSaved={() => qc.invalidateQueries({ queryKey: ["legacy_pkg_map"] })}
      />
    </div>
  );
}

export default function SettingsLegacyPackageMapping() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <Page />
    </PermissionGuard>
  );
}

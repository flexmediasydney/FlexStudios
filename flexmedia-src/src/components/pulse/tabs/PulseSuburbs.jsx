/**
 * PulseSuburbs — Suburb Pool CRUD tab for /IndustryPulse
 *
 * Manages `pulse_target_suburbs`, the source of truth for which AU suburbs
 * the pulseFireScrapes cron iterates over. Without this UI, users had to
 * edit the DB directly.
 *
 * Critical format rules (enforced both client + server side, see
 * migration 086):
 *   - name: trimmed, length >= 2, no commas (REA URL builder uses
 *     "Strathfield,+NSW+2135" — a comma in the suburb breaks the split).
 *   - postcode: exactly 4 digits, string not integer. Required for scrapes
 *     that build per-suburb URLs (pulseFireScrapes skips when missing).
 *   - state: AU code (NSW/VIC/QLD/SA/WA/ACT/TAS/NT). Defaults to NSW.
 *   - priority: 1..10 integer. Used by source configs' min_priority filter.
 *   - is_active: boolean. Soft-delete via this flag preferred over DELETE.
 *   - (lower(name), state, postcode) is unique.
 *
 * Pagination/refresh follow the BG AA/CC pattern (range + count:exact +
 * PAGE_SIZE_OPTIONS) used by EdgeFunctionAuditLog and the Pulse listings tab.
 *
 * The Suburb Pool list is also surfaced (read-only) on the Sources tab; this
 * tab is the canonical write surface.
 */

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  MapPin, Plus, Search, RefreshCw, ChevronLeft, ChevronRight,
  Edit3, Trash2, Upload, ShieldCheck, AlertTriangle, CheckCircle2,
  ArrowUp, ArrowDown, X, FileSpreadsheet, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const AU_STATES = ["NSW", "VIC", "QLD", "SA", "WA", "ACT", "TAS", "NT"];
const NSW_POSTCODE_RANGE = [2000, 2999];
const PRIORITY_RANGE = [1, 10];

// REA URL composer would split "Strathfield,+NSW+2135" on comma — so
// suburb names must NEVER contain commas. This rule is hard-enforced both
// client-side (form validation) and server-side (constraint 086).
const NAME_FORBIDDEN_CHARS = /[,]/;

// ── Validators ───────────────────────────────────────────────────────────────

/**
 * Validate a single suburb-shaped object. Returns { valid, errors[], warnings[] }.
 * Used by the add/edit form and CSV bulk-import preview.
 */
function validateSuburb(s, { allowMissingPostcode = false } = {}) {
  const errors = [];
  const warnings = [];
  const name = (s.name || "").trim();
  if (name.length < 2) errors.push("Name must be at least 2 chars.");
  if (name.length > 50) errors.push("Name must be at most 50 chars.");
  if (NAME_FORBIDDEN_CHARS.test(name)) errors.push("Name must not contain commas.");

  const state = (s.state || "").trim().toUpperCase();
  if (!AU_STATES.includes(state)) errors.push(`State must be one of: ${AU_STATES.join(", ")}.`);

  const postcodeStr = s.postcode == null ? "" : String(s.postcode).trim();
  if (!postcodeStr) {
    if (!allowMissingPostcode) errors.push("Postcode is required (4 digits).");
    else warnings.push("Postcode is missing — scrapes that build per-suburb URLs will skip this row.");
  } else if (!/^\d{4}$/.test(postcodeStr)) {
    errors.push("Postcode must be exactly 4 digits.");
  } else if (state === "NSW") {
    const n = parseInt(postcodeStr, 10);
    if (n < NSW_POSTCODE_RANGE[0] || n > NSW_POSTCODE_RANGE[1]) {
      warnings.push(`Postcode ${postcodeStr} is outside the NSW range (${NSW_POSTCODE_RANGE[0]}-${NSW_POSTCODE_RANGE[1]}).`);
    }
  }

  const priority = s.priority == null || s.priority === "" ? 5 : Number(s.priority);
  if (!Number.isInteger(priority) || priority < PRIORITY_RANGE[0] || priority > PRIORITY_RANGE[1]) {
    errors.push(`Priority must be an integer ${PRIORITY_RANGE[0]}-${PRIORITY_RANGE[1]}.`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Health-check banner ──────────────────────────────────────────────────────

/**
 * Fetches lightweight aggregate counts via 4 parallel head=true queries
 * (count:exact, no rows transferred). Used by the banner at the top of the tab.
 */
function useSuburbPoolHealth() {
  return useQuery({
    queryKey: ["pulse-suburb-pool-health"],
    queryFn: async () => {
      const sb = api._supabase;
      const [active, withPc, missingPc, highPri] = await Promise.all([
        sb.from("pulse_target_suburbs").select("id", { count: "exact", head: true }).eq("is_active", true),
        sb.from("pulse_target_suburbs").select("id", { count: "exact", head: true }).eq("is_active", true).not("postcode", "is", null),
        sb.from("pulse_target_suburbs").select("id", { count: "exact", head: true }).eq("is_active", true).is("postcode", null),
        sb.from("pulse_target_suburbs").select("id", { count: "exact", head: true }).eq("is_active", true).gte("priority", 7),
      ]);
      return {
        active: active.count || 0,
        withPostcode: withPc.count || 0,
        missingPostcode: missingPc.count || 0,
        highPriority: highPri.count || 0,
      };
    },
    refetchInterval: 60_000,
  });
}

function HealthBanner({ health }) {
  if (!health) return null;
  const hasMissing = health.missingPostcode > 0;
  return (
    <div className={cn(
      "flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg text-xs border",
      hasMissing
        ? "border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20"
        : "border-emerald-300/60 bg-emerald-50/40 dark:bg-emerald-950/20",
    )}>
      <span className="inline-flex items-center gap-1 font-semibold">
        <MapPin className="h-3.5 w-3.5" />
        Suburb pool health
      </span>
      <span className="text-muted-foreground">·</span>
      <span><span className="font-bold">{health.active}</span> active</span>
      <span className="text-muted-foreground">·</span>
      <span><span className="font-bold">{health.withPostcode}</span> with postcode</span>
      {hasMissing && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-amber-700 dark:text-amber-400 font-medium inline-flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            <span className="font-bold">{health.missingPostcode}</span> missing postcode
          </span>
        </>
      )}
      <span className="text-muted-foreground">·</span>
      <span><span className="font-bold">{health.highPriority}</span> high-priority (≥7)</span>
    </div>
  );
}

// ── Main tab ─────────────────────────────────────────────────────────────────

export default function PulseSuburbs() {
  const qc = useQueryClient();

  // Filter / pagination state
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("active"); // active | inactive | all
  const [minPriority, setMinPriority] = useState(0); // 0 = no filter
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState("priority");
  const [sortDir, setSortDir] = useState("desc");

  // Reset page on filter change (search debounced separately)
  useEffect(() => { setPage(0); }, [activeFilter, minPriority, pageSize, search]);

  // Modal state
  const [editing, setEditing] = useState(null); // null | suburb row | "new"
  const [confirmDelete, setConfirmDelete] = useState(null); // suburb to deactivate
  const [csvOpen, setCsvOpen] = useState(false);
  const [validateOpen, setValidateOpen] = useState(false);

  // ── Data ──
  const { data: health } = useSuburbPoolHealth();

  const queryKey = useMemo(
    () => ["pulse-target-suburbs", { activeFilter, minPriority, pageSize, page, sortKey, sortDir, search }],
    [activeFilter, minPriority, pageSize, page, sortKey, sortDir, search],
  );

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      let q = api._supabase
        .from("pulse_target_suburbs")
        .select("*", { count: "exact" });
      if (activeFilter === "active") q = q.eq("is_active", true);
      else if (activeFilter === "inactive") q = q.eq("is_active", false);
      if (minPriority > 0) q = q.gte("priority", minPriority);
      if (search.trim()) {
        const s = search.trim().replace(/[%_]/g, "\\$&");
        q = q.or(`name.ilike.%${s}%,postcode.ilike.%${s}%,region.ilike.%${s}%`);
      }
      // Server-side sort + pagination
      q = q.order(sortKey, { ascending: sortDir === "asc", nullsFirst: false });
      const from = page * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data: rows, error, count } = await q;
      if (error) throw error;
      return { rows: rows || [], count: count || 0 };
    },
    keepPreviousData: true,
  });

  const rows = data?.rows || [];
  const total = data?.count || 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min(total, (page + 1) * pageSize);

  const refreshAll = useCallback(() => {
    refetch();
    qc.invalidateQueries({ queryKey: ["pulse-suburb-pool-health"] });
    refetchEntityList("PulseTargetSuburb");
  }, [refetch, qc]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  };

  // ── Inline edit (priority, is_active, region, notes) ──
  const inlineUpdate = useCallback(async (id, patch) => {
    try {
      await api.entities.PulseTargetSuburb.update(id, patch);
      refreshAll();
    } catch (err) {
      toast.error(`Update failed: ${err.message}`);
    }
  }, [refreshAll]);

  // ── Deactivate (soft-delete) ──
  const handleDeactivate = useCallback(async (suburb) => {
    try {
      await api.entities.PulseTargetSuburb.update(suburb.id, { is_active: false });
      toast.success(`Deactivated ${suburb.name}`);
      setConfirmDelete(null);
      refreshAll();
    } catch (err) {
      toast.error(`Deactivate failed: ${err.message}`);
    }
  }, [refreshAll]);

  // ── Hard delete (admin escape hatch — only offered when row already inactive) ──
  const handleHardDelete = useCallback(async (suburb) => {
    try {
      await api.entities.PulseTargetSuburb.delete(suburb.id);
      toast.success(`Removed ${suburb.name}`);
      setConfirmDelete(null);
      refreshAll();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  }, [refreshAll]);

  return (
    <div className="space-y-3">
      {/* Header row — actions */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            Suburb Pool
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {total} {activeFilter === "all" ? "total" : activeFilter}
            </Badge>
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Source of truth for which AU suburbs the pulseFireScrapes cron iterates over.
            Edit, add, or bulk-import. Soft-delete via Deactivate; hard-delete only after.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => setValidateOpen(true)}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Validate pool
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => setCsvOpen(true)}>
            <Upload className="h-3.5 w-3.5" />
            Bulk CSV
          </Button>
          <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" />
            Add suburb
          </Button>
          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={refreshAll} disabled={isFetching} title="Refresh">
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      <HealthBanner health={health} />

      {/* Filters strip */}
      <Card className="rounded-xl border shadow-sm">
        <CardContent className="p-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Name, postcode, region…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>
            <div>
              <Select value={activeFilter} onValueChange={setActiveFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active only</SelectItem>
                  <SelectItem value="inactive">Inactive only</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Select value={String(minPriority)} onValueChange={(v) => setMinPriority(Number(v))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">All priorities</SelectItem>
                  <SelectItem value="3">P ≥ 3</SelectItem>
                  <SelectItem value="5">P ≥ 5</SelectItem>
                  <SelectItem value="7">P ≥ 7 (cron threshold)</SelectItem>
                  <SelectItem value="9">P ≥ 9</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map(n => (
                    <SelectItem key={n} value={String(n)}>{n} per page</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="rounded-xl border shadow-sm">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
              Loading suburbs…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              No suburbs match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead label="Name" k="name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <TableHead className="w-[60px]">State</TableHead>
                    <TableHead className="w-[80px]">Postcode</TableHead>
                    <TableHead>Region</TableHead>
                    <SortableHead label="Priority" k="priority" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="w-[90px]" />
                    <TableHead className="w-[80px]">Active</TableHead>
                    <SortableHead label="Created" k="created_at" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="w-[120px]" />
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => (
                    <SuburbRow
                      key={s.id}
                      suburb={s}
                      onEdit={setEditing}
                      onDeactivateRequest={setConfirmDelete}
                      onInlineUpdate={inlineUpdate}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-xs px-1">
          <span className="text-muted-foreground">
            Showing {showingFrom}–{showingTo} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Page {page + 1} of {pageCount}</span>
            <Button size="sm" variant="outline" className="h-7 px-2 gap-1" disabled={page === 0 || isFetching} onClick={() => setPage(p => Math.max(0, p - 1))}>
              <ChevronLeft className="h-3 w-3" />
              Prev
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 gap-1" disabled={page + 1 >= pageCount || isFetching} onClick={() => setPage(p => p + 1)}>
              Next
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      {/* Add/Edit dialog */}
      {editing && (
        <SuburbEditDialog
          suburb={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refreshAll}
        />
      )}

      {/* Deactivate confirm */}
      {confirmDelete && (
        <DeactivateConfirm
          suburb={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onDeactivate={() => handleDeactivate(confirmDelete)}
          onHardDelete={() => handleHardDelete(confirmDelete)}
        />
      )}

      {/* Bulk CSV import */}
      {csvOpen && (
        <BulkCsvDialog onClose={() => setCsvOpen(false)} onImported={refreshAll} />
      )}

      {/* Validate pool */}
      {validateOpen && (
        <ValidatePoolDialog onClose={() => setValidateOpen(false)} onFixed={refreshAll} />
      )}
    </div>
  );
}

// ── Sortable column header ───────────────────────────────────────────────────

function SortableHead({ label, k, sortKey, sortDir, onSort, className }) {
  const active = sortKey === k;
  return (
    <TableHead className={cn("cursor-pointer select-none", className)} onClick={() => onSort(k)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </TableHead>
  );
}

// ── Single row with inline editors ───────────────────────────────────────────

function SuburbRow({ suburb, onEdit, onDeactivateRequest, onInlineUpdate }) {
  const [priorityEdit, setPriorityEdit] = useState(false);
  const [pTmp, setPTmp] = useState(suburb.priority ?? 5);

  const savePriority = useCallback(async () => {
    const n = Number(pTmp);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      toast.error("Priority must be 1-10");
      setPriorityEdit(false);
      return;
    }
    if (n !== suburb.priority) await onInlineUpdate(suburb.id, { priority: n });
    setPriorityEdit(false);
  }, [pTmp, suburb.priority, suburb.id, onInlineUpdate]);

  const missingPostcode = !suburb.postcode;

  return (
    <TableRow className={cn(!suburb.is_active && "opacity-50")}>
      <TableCell className="font-medium">
        <div className="flex items-center gap-1.5">
          <span>{suburb.name}</span>
          {missingPostcode && (
            <span title="Missing postcode — pulseFireScrapes will skip this suburb">
              <AlertTriangle className="h-3 w-3 text-amber-500" />
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-xs font-mono">{suburb.state || "—"}</TableCell>
      <TableCell className="text-xs font-mono">{suburb.postcode || <span className="text-amber-600">—</span>}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{suburb.region || "—"}</TableCell>
      <TableCell>
        {priorityEdit ? (
          <Input
            autoFocus
            type="number"
            min={1}
            max={10}
            value={pTmp}
            onChange={(e) => setPTmp(e.target.value)}
            onBlur={savePriority}
            onKeyDown={(e) => {
              if (e.key === "Enter") savePriority();
              if (e.key === "Escape") { setPTmp(suburb.priority ?? 5); setPriorityEdit(false); }
            }}
            className="h-6 w-14 text-xs"
          />
        ) : (
          <button onClick={() => { setPTmp(suburb.priority ?? 5); setPriorityEdit(true); }} title="Click to edit">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 hover:bg-muted cursor-pointer">
              P{suburb.priority ?? 0}
            </Badge>
          </button>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={!!suburb.is_active}
          onCheckedChange={(checked) => onInlineUpdate(suburb.id, { is_active: checked })}
          aria-label={suburb.is_active ? "Deactivate" : "Activate"}
        />
      </TableCell>
      <TableCell className="text-[11px] text-muted-foreground tabular-nums">
        {suburb.created_at ? new Date(suburb.created_at).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onEdit(suburb)} title="Edit details">
            <Edit3 className="h-3 w-3" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-red-600 hover:text-red-700" onClick={() => onDeactivateRequest(suburb)} title={suburb.is_active ? "Deactivate" : "Delete"}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── Add / Edit dialog ────────────────────────────────────────────────────────

function SuburbEditDialog({ suburb, onClose, onSaved }) {
  const isNew = !suburb;
  const [form, setForm] = useState({
    name: suburb?.name || "",
    state: suburb?.state || "NSW",
    postcode: suburb?.postcode || "",
    region: suburb?.region || "",
    priority: suburb?.priority ?? 5,
    is_active: suburb?.is_active ?? true,
    notes: suburb?.notes || "",
  });
  const [saving, setSaving] = useState(false);

  const validation = useMemo(() => validateSuburb(form), [form]);

  const save = useCallback(async () => {
    if (!validation.valid) {
      toast.error(validation.errors[0] || "Fix the highlighted fields");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        state: form.state.toUpperCase(),
        postcode: form.postcode.trim(),
        region: form.region.trim() || null,
        priority: Number(form.priority),
        is_active: !!form.is_active,
        notes: form.notes.trim() || null,
      };
      if (isNew) {
        // Pre-check duplicate (lower(name)+state+postcode) to give a friendly error
        // before we hit the unique-index constraint.
        const { data: dup, error: dupErr } = await api._supabase
          .from("pulse_target_suburbs")
          .select("id, name, state, postcode")
          .ilike("name", payload.name)
          .eq("state", payload.state)
          .eq("postcode", payload.postcode)
          .limit(1);
        if (dupErr) throw dupErr;
        if (dup && dup.length > 0) {
          toast.error(`Duplicate: ${payload.name}, ${payload.state} ${payload.postcode} already exists.`);
          setSaving(false);
          return;
        }
        await api.entities.PulseTargetSuburb.create(payload);
        toast.success(`Added ${payload.name}`);
      } else {
        await api.entities.PulseTargetSuburb.update(suburb.id, payload);
        toast.success(`Updated ${payload.name}`);
      }
      onSaved();
      onClose();
    } catch (err) {
      // Postgres returns 23505 for unique violations
      const msg = err.message || String(err);
      if (msg.includes("unique") || msg.includes("23505")) {
        toast.error("Duplicate name+state+postcode combo.");
      } else if (msg.includes("postcode_format")) {
        toast.error("Postcode must be exactly 4 digits.");
      } else {
        toast.error(`Save failed: ${msg}`);
      }
    } finally {
      setSaving(false);
    }
  }, [form, isNew, suburb, onSaved, onClose, validation]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            {isNew ? "Add suburb" : `Edit ${suburb.name}`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isNew
              ? "Adds to the pulse_target_suburbs pool. Cron pickups happen on next scheduled fire."
              : "Changes apply immediately to all subsequent cron fires."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-[10px] uppercase">Name</Label>
            <Input
              autoFocus
              value={form.name}
              onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Strathfield"
              className="h-8 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] uppercase">State</Label>
              <Select value={form.state} onValueChange={(v) => setForm(f => ({ ...f, state: v }))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AU_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[10px] uppercase">Postcode</Label>
              <Input
                value={form.postcode}
                onChange={(e) => setForm(f => ({ ...f, postcode: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                placeholder="e.g. 2135"
                inputMode="numeric"
                maxLength={4}
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
          <div>
            <Label className="text-[10px] uppercase">Region (optional)</Label>
            <Input
              value={form.region}
              onChange={(e) => setForm(f => ({ ...f, region: e.target.value }))}
              placeholder="e.g. Inner West, Eastern Suburbs"
              className="h-8 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 items-end">
            <div>
              <Label className="text-[10px] uppercase">Priority (1-10)</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={form.priority}
                onChange={(e) => setForm(f => ({ ...f, priority: e.target.value }))}
                className="h-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-2 pb-1">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm(f => ({ ...f, is_active: v }))} />
              <Label className="text-xs">{form.is_active ? "Active" : "Inactive"}</Label>
            </div>
          </div>
          <div>
            <Label className="text-[10px] uppercase">Notes (optional)</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Internal notes about this suburb"
              className="text-xs min-h-[60px]"
            />
          </div>

          {(validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="text-[11px] space-y-0.5">
              {validation.errors.map((e, i) => (
                <p key={`e${i}`} className="text-red-700 dark:text-red-400 flex items-center gap-1">
                  <X className="h-3 w-3" />{e}
                </p>
              ))}
              {validation.warnings.map((w, i) => (
                <p key={`w${i}`} className="text-amber-700 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />{w}
                </p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !validation.valid}>
            {saving ? <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Saving…</> : (isNew ? "Add" : "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Deactivate / hard-delete confirm ─────────────────────────────────────────

function DeactivateConfirm({ suburb, onCancel, onDeactivate, onHardDelete }) {
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            {suburb.is_active ? "Deactivate" : "Delete"} {suburb.name}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-xs space-y-2">
            {suburb.is_active ? (
              <span>
                This will stop pulse scrapes including <span className="font-semibold">{suburb.name}</span> on the next cron fire. Existing data is preserved.
                You can re-activate at any time.
              </span>
            ) : (
              <span>
                <span className="text-red-700">Hard-delete</span> permanently removes the row.
                Sync logs that referenced this suburb (by name) remain intact.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {suburb.is_active ? (
            <AlertDialogAction onClick={onDeactivate} className="bg-amber-600 hover:bg-amber-700">
              Deactivate
            </AlertDialogAction>
          ) : (
            <AlertDialogAction onClick={onHardDelete} className="bg-red-600 hover:bg-red-700">
              Delete permanently
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Bulk CSV import ──────────────────────────────────────────────────────────

/**
 * Parse a CSV string into rows of {name,postcode,state,region,priority}.
 * Tolerates UTF-8 BOM, trims whitespace, ignores blank lines. Returns
 * an array of `{raw, parsed, validation, dupKey}` so the preview can show
 * each row's status before import.
 */
function parseCsv(text) {
  const cleaned = text.replace(/^\uFEFF/, ""); // strip BOM
  const lines = cleaned.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 1) return { rows: [], header: [] };

  // Naive CSV split — sufficient for our schema (no quoted commas expected).
  const splitLine = (l) => l.split(",").map(c => c.trim());
  const header = splitLine(lines[0]).map(h => h.toLowerCase());
  const required = ["name", "postcode"];
  for (const r of required) {
    if (!header.includes(r)) {
      throw new Error(`CSV header is missing required column: ${r}. Got: ${header.join(",")}`);
    }
  }

  const rows = lines.slice(1).map((line, idx) => {
    const cells = splitLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = cells[i] ?? "";
    }
    return { lineNo: idx + 2, raw: line, row };
  });

  return { rows, header };
}

function BulkCsvDialog({ onClose, onImported }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null); // { rows, header }
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [importing, setImporting] = useState(false);

  const parse = useCallback(() => {
    try {
      const result = parseCsv(text);
      // Validate each row + check duplicates within the file
      const seen = new Set();
      const enriched = result.rows.map(({ lineNo, raw, row }) => {
        const data = {
          name: (row.name || "").trim(),
          state: ((row.state || "NSW") || "NSW").toUpperCase().trim(),
          postcode: (row.postcode || "").trim(),
          region: (row.region || "").trim(),
          priority: row.priority ? Number(row.priority) : 5,
        };
        const v = validateSuburb(data);
        const key = `${data.name.toLowerCase()}|${data.state}|${data.postcode}`;
        const isDup = seen.has(key);
        if (!isDup) seen.add(key);
        return {
          lineNo, raw, data,
          valid: v.valid && !isDup,
          errors: [...v.errors, ...(isDup ? ["Duplicate within CSV (name+state+postcode)"] : [])],
          warnings: v.warnings,
        };
      });
      setParsed({ ...result, rows: enriched });
    } catch (err) {
      toast.error(err.message);
      setParsed(null);
    }
  }, [text]);

  const validRows = parsed?.rows.filter(r => r.valid) || [];
  const invalidRows = parsed?.rows.filter(r => !r.valid) || [];

  const doImport = useCallback(async () => {
    if (!parsed) return;
    if (invalidRows.length > 0 && !skipInvalid) {
      toast.error(`${invalidRows.length} invalid rows. Fix the CSV or check 'skip invalid rows'.`);
      return;
    }
    setImporting(true);
    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (const row of validRows) {
        try {
          const payload = {
            name: row.data.name,
            state: row.data.state,
            postcode: row.data.postcode,
            region: row.data.region || null,
            priority: row.data.priority,
            is_active: true,
          };
          // Upsert via on_conflict on the unique (lower(name), state, postcode) index
          const { error } = await api._supabase
            .from("pulse_target_suburbs")
            .insert(payload);
          if (error) {
            // Treat unique violations as "skipped" rather than "failed"
            if (error.code === "23505" || (error.message || "").includes("unique")) skipped++;
            else { failed++; console.warn(`CSV row ${row.lineNo} insert failed:`, error.message); }
          } else inserted++;
        } catch (err) {
          failed++;
          console.warn(`CSV row ${row.lineNo} insert exception:`, err.message);
        }
      }
      const summary = `${inserted} added · ${skipped} skipped (already exist) · ${failed} failed`;
      if (failed > 0) toast.warning(`CSV import: ${summary}`);
      else toast.success(`CSV import: ${summary}`);
      onImported();
      onClose();
    } finally {
      setImporting(false);
    }
  }, [parsed, validRows, invalidRows, skipInvalid, onImported, onClose]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            Bulk CSV import
          </DialogTitle>
          <DialogDescription className="text-xs">
            CSV columns: <code className="font-mono">name,postcode,state,region,priority</code>.
            <code className="font-mono"> name</code> and <code className="font-mono">postcode</code> required;
            others default to NSW / "" / 5.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            placeholder={"name,postcode,state,region,priority\nStrathfield,2135,NSW,Inner West,7\nManly,2095,NSW,Northern Beaches,8"}
            value={text}
            onChange={(e) => { setText(e.target.value); setParsed(null); }}
            className="text-xs font-mono min-h-[140px]"
          />
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={parse} disabled={!text.trim()}>
              Preview
            </Button>
            {parsed && (
              <div className="text-xs text-muted-foreground inline-flex items-center gap-3">
                <span className="text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="inline h-3 w-3 mr-0.5" />{validRows.length} valid</span>
                {invalidRows.length > 0 && (
                  <span className="text-red-700 dark:text-red-400"><X className="inline h-3 w-3 mr-0.5" />{invalidRows.length} invalid</span>
                )}
              </div>
            )}
          </div>

          {parsed && (
            <div className="rounded-md border max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">Line</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-[60px]">State</TableHead>
                    <TableHead className="w-[80px]">Postcode</TableHead>
                    <TableHead className="w-[60px]">P</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed.rows.map(r => (
                    <TableRow key={r.lineNo} className={cn(!r.valid && "bg-red-50/50 dark:bg-red-950/10")}>
                      <TableCell className="text-[10px] font-mono text-muted-foreground">{r.lineNo}</TableCell>
                      <TableCell className="text-xs">{r.data.name || "—"}</TableCell>
                      <TableCell className="text-xs font-mono">{r.data.state}</TableCell>
                      <TableCell className="text-xs font-mono">{r.data.postcode || "—"}</TableCell>
                      <TableCell className="text-xs">{r.data.priority}</TableCell>
                      <TableCell className="text-[10px]">
                        {r.valid
                          ? r.warnings.length > 0
                            ? <span className="text-amber-700">Warning: {r.warnings.join(" ")}</span>
                            : <span className="text-emerald-700">OK</span>
                          : <span className="text-red-700">{r.errors.join(" ")}</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {parsed && invalidRows.length > 0 && (
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={skipInvalid}
                onChange={(e) => setSkipInvalid(e.target.checked)}
              />
              <span>Skip invalid rows and import the {validRows.length} valid ones</span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>Cancel</Button>
          <Button
            onClick={doImport}
            disabled={importing || !parsed || validRows.length === 0 || (invalidRows.length > 0 && !skipInvalid)}
          >
            {importing ? <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Importing…</> : `Import ${validRows.length} rows`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Validate pool — full-table scan + per-row issues ─────────────────────────

function ValidatePoolDialog({ onClose, onFixed }) {
  const [scanning, setScanning] = useState(true);
  const [issues, setIssues] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // One full scan — pool is small (<1k typically). We pull all rows then
        // group + validate locally rather than firing N queries.
        const { data, error } = await api._supabase
          .from("pulse_target_suburbs")
          .select("id, name, state, postcode, region, priority, is_active")
          .order("name");
        if (error) throw error;
        if (cancelled) return;

        const out = [];
        // Group dup-detection by lower(name)+state
        const dupKeys = new Map();
        for (const s of data || []) {
          const k = `${(s.name || "").toLowerCase()}|${s.state || ""}`;
          if (!dupKeys.has(k)) dupKeys.set(k, []);
          dupKeys.get(k).push(s);
        }
        for (const s of data || []) {
          const v = validateSuburb({
            name: s.name,
            state: s.state,
            postcode: s.postcode,
            priority: s.priority,
          }, { allowMissingPostcode: true });
          const dupGroup = dupKeys.get(`${(s.name || "").toLowerCase()}|${s.state || ""}`) || [];
          const isDup = dupGroup.length > 1;
          if (v.errors.length === 0 && v.warnings.length === 0 && !isDup) continue;
          out.push({
            suburb: s,
            errors: v.errors,
            warnings: v.warnings,
            duplicate: isDup ? `${dupGroup.length}x ${s.name} in ${s.state}` : null,
          });
        }
        setIssues(out);
      } catch (err) {
        toast.error(`Validate scan failed: ${err.message}`);
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const fixIt = async (suburb, patch) => {
    try {
      await api.entities.PulseTargetSuburb.update(suburb.id, patch);
      toast.success(`Updated ${suburb.name}`);
      // Optimistically remove from issues
      setIssues(curr => curr.filter(i => i.suburb.id !== suburb.id));
      onFixed();
    } catch (err) {
      toast.error(`Update failed: ${err.message}`);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Validate suburb pool
          </DialogTitle>
          <DialogDescription className="text-xs">
            Scans all rows for missing postcodes, malformed values, name issues, and duplicates.
          </DialogDescription>
        </DialogHeader>

        {scanning ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
            Scanning…
          </div>
        ) : issues.length === 0 ? (
          <div className="py-8 text-center text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-5 w-5 mx-auto mb-2" />
            No issues found. The pool is clean.
          </div>
        ) : (
          <div className="rounded-md border max-h-72 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Suburb</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead className="w-[120px]">Fix</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.map(({ suburb, errors, warnings, duplicate }) => (
                  <TableRow key={suburb.id}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{suburb.name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        {suburb.state} {suburb.postcode || "—"} P{suburb.priority ?? 0} · {suburb.is_active ? "active" : "inactive"}
                      </div>
                    </TableCell>
                    <TableCell className="text-[11px] space-y-0.5">
                      {errors.map((e, i) => <div key={`e${i}`} className="text-red-700 dark:text-red-400">{e}</div>)}
                      {warnings.map((w, i) => <div key={`w${i}`} className="text-amber-700 dark:text-amber-400">{w}</div>)}
                      {duplicate && <div className="text-amber-700 dark:text-amber-400">Duplicate: {duplicate}</div>}
                    </TableCell>
                    <TableCell>
                      {(!suburb.postcode || /^[^\d]/.test(suburb.postcode || "")) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px]"
                          onClick={() => {
                            const v = prompt(`Enter postcode for ${suburb.name}:`, "");
                            if (v && /^\d{4}$/.test(v.trim())) fixIt(suburb, { postcode: v.trim() });
                            else if (v != null) toast.error("Postcode must be 4 digits");
                          }}
                        >
                          Set postcode
                        </Button>
                      )}
                      {suburb.is_active && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px] text-amber-700"
                          onClick={() => fixIt(suburb, { is_active: false })}
                        >
                          Deactivate
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

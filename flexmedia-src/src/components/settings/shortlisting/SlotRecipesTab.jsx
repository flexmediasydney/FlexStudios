/**
 * SlotRecipesTab — Wave 11.6.25.
 *
 * 21st tab inside the Shortlisting Command Center. Editor for
 * shortlisting_slot_allocations rows. master_admin only.
 *
 * Layout (per Joseph's brief):
 *   - Scope picker: scope_type + scope_ref dropdown
 *   - Allocations editor: row per slot_id with classification / count / max /
 *     priority_rank / notes; [+ Add slot row]
 *   - Tolerance overrides for scope_type='package' only.
 *   - Resolved-recipe preview.
 *
 * Persistence: straight UPSERT (no version column — Joseph confirmed UPDATE
 * in place). Soft-delete via is_active=false.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Save, Trash2, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";

const CLASSIFICATIONS = ["mandatory", "conditional", "free_recommendation"];
const SCOPE_TYPES = [
  { key: "project_type", label: "Project Type" },
  { key: "package_tier", label: "Package Tier" },
  { key: "package", label: "Package" },
  { key: "individual_product", label: "Individual Product" },
];

const CLASS_RANK = { free_recommendation: 0, conditional: 1, mandatory: 2 };

export default function SlotRecipesTab() {
  const qc = useQueryClient();
  const [scopeType, setScopeType] = useState("package_tier");
  const [scopeRefId, setScopeRefId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [savingRowId, setSavingRowId] = useState(null);

  const refsQuery = useQuery({
    queryKey: ["slot-recipes-refs"],
    queryFn: async () => {
      const [tiers, packages, projectTypes, products, slots] = await Promise.all([
        supabase
          .from("shortlisting_tiers")
          .select("id, tier_code, display_name")
          .eq("is_active", true)
          .order("display_order"),
        supabase
          .from("packages")
          .select("id, name, expected_count_tolerance_below, expected_count_tolerance_above")
          .eq("is_active", true)
          .order("name"),
        supabase
          .from("project_types")
          .select("id, name")
          .order("name"),
        supabase
          .from("products")
          .select("id, name")
          .eq("is_active", true)
          .order("name")
          .limit(500),
        supabase
          .from("shortlisting_slot_definitions")
          .select("slot_id, display_name, phase, min_images, max_images, version, is_active")
          .eq("is_active", true)
          .order("phase")
          .order("slot_id"),
      ]);
      const errors = [
        tiers.error?.message,
        packages.error?.message,
        projectTypes.error?.message,
        products.error?.message,
        slots.error?.message,
      ].filter(Boolean);
      if (errors.length > 0) throw new Error(errors.join("; "));
      const slotByLatest = new Map();
      for (const s of slots.data || []) {
        const existing = slotByLatest.get(s.slot_id);
        if (!existing || (s.version || 1) > (existing.version || 1)) {
          slotByLatest.set(s.slot_id, s);
        }
      }
      return {
        tiers: tiers.data || [],
        packages: packages.data || [],
        projectTypes: projectTypes.data || [],
        products: products.data || [],
        slots: Array.from(slotByLatest.values()),
      };
    },
    staleTime: 60_000,
  });

  const tolDefaultsQuery = useQuery({
    queryKey: ["slot-recipes-tolerance-defaults"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("engine_settings")
        .select("key, value")
        .in("key", ["expected_count_tolerance_below", "expected_count_tolerance_above"]);
      if (error) throw new Error(error.message);
      const out = { below: 3, above: 3 };
      for (const r of data || []) {
        const v = typeof r.value === "number" ? r.value : Number(r.value);
        if (Number.isFinite(v)) {
          if (r.key === "expected_count_tolerance_below") out.below = v;
          if (r.key === "expected_count_tolerance_above") out.above = v;
        }
      }
      return out;
    },
    staleTime: 60_000,
  });

  const allocsQuery = useQuery({
    queryKey: ["slot-recipes-allocs", scopeType, scopeRefId],
    queryFn: async () => {
      if (!scopeRefId) return [];
      const { data, error } = await supabase
        .from("shortlisting_slot_allocations")
        .select(
          "id, scope_type, scope_ref_id, slot_id, classification, allocated_count, max_count, priority_rank, notes, is_active",
        )
        .eq("is_active", true)
        .eq("scope_type", scopeType)
        .eq("scope_ref_id", scopeRefId)
        .order("priority_rank");
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: Boolean(scopeRefId),
  });

  const scopeRefChoices = useMemo(() => {
    if (!refsQuery.data) return [];
    if (scopeType === "package_tier") {
      return refsQuery.data.tiers.map((t) => ({
        id: t.id,
        label: `${t.tier_code} — ${t.display_name}`,
      }));
    }
    if (scopeType === "package") {
      return refsQuery.data.packages.map((p) => ({ id: p.id, label: p.name }));
    }
    if (scopeType === "project_type") {
      return refsQuery.data.projectTypes.map((p) => ({ id: p.id, label: p.name }));
    }
    return refsQuery.data.products.map((p) => ({ id: p.id, label: p.name }));
  }, [refsQuery.data, scopeType]);

  const selectedPackage = useMemo(() => {
    if (scopeType !== "package" || !refsQuery.data) return null;
    return refsQuery.data.packages.find((p) => p.id === scopeRefId) || null;
  }, [scopeType, scopeRefId, refsQuery.data]);

  const upsertMutation = useMutation({
    mutationFn: async (payload) => {
      const { id, ...row } = payload;
      if (id) {
        const { error } = await supabase
          .from("shortlisting_slot_allocations")
          .update(row)
          .eq("id", id);
        if (error) throw new Error(error.message);
        return { id };
      }
      const { data, error } = await supabase
        .from("shortlisting_slot_allocations")
        .insert(row)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    onMutate: ({ id }) => setSavingRowId(id || "new"),
    onSettled: () => setSavingRowId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slot-recipes-allocs", scopeType, scopeRefId] });
      toast.success("Saved.");
      setDrafts({});
    },
    onError: (err) => toast.error(`Save failed: ${err?.message || err}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase
        .from("shortlisting_slot_allocations")
        .update({ is_active: false })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slot-recipes-allocs", scopeType, scopeRefId] });
      toast.success("Removed.");
    },
    onError: (err) => toast.error(`Delete failed: ${err?.message || err}`),
  });

  const tolMutation = useMutation({
    mutationFn: async ({ packageId, below, above }) => {
      const { error } = await supabase
        .from("packages")
        .update({
          expected_count_tolerance_below: below === "" ? null : Number(below),
          expected_count_tolerance_above: above === "" ? null : Number(above),
        })
        .eq("id", packageId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slot-recipes-refs"] });
      toast.success("Tolerance saved.");
    },
    onError: (err) => toast.error(`Tolerance save failed: ${err?.message || err}`),
  });

  if (refsQuery.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="slot-recipes-skeleton" />;
  }
  if (refsQuery.error) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-sm text-red-600">
            Failed to load reference data: {refsQuery.error.message}
          </div>
        </CardContent>
      </Card>
    );
  }

  const slots = refsQuery.data?.slots || [];
  const allocations = allocsQuery.data || [];

  const totals = (() => {
    let mandatory = 0;
    let conditional = 0;
    let freeRec = 0;
    for (const a of allocations) {
      const draft = drafts[a.id] || {};
      const cls = draft.classification ?? a.classification;
      const count = Number(draft.allocated_count ?? a.allocated_count) || 0;
      if (cls === "mandatory") mandatory += count;
      else if (cls === "conditional") conditional += count;
      else freeRec += count;
    }
    return { mandatory, conditional, freeRec, total: mandatory + conditional + freeRec };
  })();

  const previewEntries = (() => {
    if (allocations.length === 0) return [];
    const slotById = new Map(slots.map((s) => [s.slot_id, s]));
    return allocations
      .map((a) => {
        const draft = drafts[a.id] || {};
        const slotDef = slotById.get(a.slot_id);
        const allocated = Number(draft.allocated_count ?? a.allocated_count) || 0;
        const recipeMax = draft.max_count !== undefined && draft.max_count !== ""
          ? Number(draft.max_count)
          : (a.max_count === null || a.max_count === undefined ? null : Number(a.max_count));
        const slotMax = slotDef?.max_images ?? null;
        let resolvedMax;
        if (recipeMax !== null && slotMax !== null) resolvedMax = Math.max(recipeMax, slotMax);
        else if (recipeMax !== null) resolvedMax = recipeMax;
        else if (slotMax !== null) resolvedMax = slotMax;
        else resolvedMax = allocated;
        if (resolvedMax < allocated) resolvedMax = allocated;
        return {
          slot_id: a.slot_id,
          classification: draft.classification ?? a.classification,
          allocated_count: allocated,
          max_count: resolvedMax,
          priority_rank: Number(draft.priority_rank ?? a.priority_rank) || 100,
        };
      })
      .sort((a, b) => {
        const cdiff = (CLASS_RANK[b.classification] ?? 0) - (CLASS_RANK[a.classification] ?? 0);
        if (cdiff !== 0) return cdiff;
        return a.priority_rank - b.priority_rank;
      });
  })();

  return (
    <div className="space-y-3" data-testid="slot-recipes-tab">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Layers className="h-4 w-4 text-blue-600" />
          Slot Recipes
        </h2>
        <p className="text-xs text-muted-foreground">
          Per-scope allocation rules. Pick a scope, edit the rows, save.
          Resolver runs at round ingest — mid-round edits don't affect
          in-flight rounds (replay-safe).
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Edit recipe for</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 items-end">
          <div className="flex-1">
            <Label className="text-xs">Scope type</Label>
            <Select
              value={scopeType}
              onValueChange={(v) => {
                setScopeType(v);
                setScopeRefId(null);
                setDrafts({});
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_TYPES.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-[2]">
            <Label className="text-xs">Scope target</Label>
            <Select
              value={scopeRefId || ""}
              onValueChange={(v) => {
                setScopeRefId(v);
                setDrafts({});
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {scopeRefChoices.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {scopeRefId && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Allocations</CardTitle>
            <CardDescription className="text-xs">
              One row per slot. Save persists straight to the table — no version
              history (Joseph confirmed straight UPDATEs).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {allocsQuery.isLoading && <Skeleton className="h-20 w-full" />}
            {allocsQuery.error && (
              <div className="text-sm text-red-600">{allocsQuery.error.message}</div>
            )}
            {!allocsQuery.isLoading && allocations.length === 0 && (
              <div className="text-xs text-muted-foreground">
                No allocations for this scope. Use [+ Add slot row] to create one.
              </div>
            )}
            {allocations.length > 0 && (
              <div className="grid grid-cols-12 gap-2 text-xs font-medium">
                <div className="col-span-3">Slot</div>
                <div className="col-span-2">Class</div>
                <div className="col-span-1">Count</div>
                <div className="col-span-1">Max</div>
                <div className="col-span-1">Rank</div>
                <div className="col-span-3">Notes</div>
                <div className="col-span-1" />
              </div>
            )}
            {allocations.map((row) => {
              const draft = drafts[row.id] || {};
              const isDirty = Object.keys(draft).length > 0;
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-12 gap-2 items-center"
                  data-testid={`alloc-row-${row.slot_id}`}
                >
                  <div className="col-span-3 text-xs">{row.slot_id}</div>
                  <div className="col-span-2">
                    <Select
                      value={draft.classification ?? row.classification}
                      onValueChange={(v) =>
                        setDrafts((d) => ({
                          ...d,
                          [row.id]: { ...(d[row.id] || {}), classification: v },
                        }))
                      }
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLASSIFICATIONS.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-1">
                    <Input
                      type="number"
                      className="h-7 text-xs"
                      value={draft.allocated_count ?? row.allocated_count}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [row.id]: { ...(d[row.id] || {}), allocated_count: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="col-span-1">
                    <Input
                      type="number"
                      className="h-7 text-xs"
                      placeholder="—"
                      value={draft.max_count ?? row.max_count ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [row.id]: { ...(d[row.id] || {}), max_count: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="col-span-1">
                    <Input
                      type="number"
                      className="h-7 text-xs"
                      value={draft.priority_rank ?? row.priority_rank}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [row.id]: { ...(d[row.id] || {}), priority_rank: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="col-span-3">
                    <Input
                      className="h-7 text-xs"
                      placeholder="Notes"
                      value={draft.notes ?? row.notes ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [row.id]: { ...(d[row.id] || {}), notes: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="col-span-1 flex gap-1 justify-end">
                    {isDirty && (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 px-2"
                        disabled={savingRowId === row.id}
                        onClick={() => {
                          const merged = { ...row, ...draft };
                          if (typeof merged.allocated_count === "string") {
                            merged.allocated_count = Number(merged.allocated_count) || 0;
                          }
                          if (typeof merged.max_count === "string") {
                            merged.max_count = merged.max_count === ""
                              ? null
                              : Number(merged.max_count);
                          }
                          if (typeof merged.priority_rank === "string") {
                            merged.priority_rank = Number(merged.priority_rank) || 100;
                          }
                          upsertMutation.mutate(merged);
                        }}
                        data-testid={`save-alloc-${row.slot_id}`}
                      >
                        {savingRowId === row.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Save className="h-3 w-3" />
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      onClick={() => deleteMutation.mutate(row.id)}
                      data-testid={`delete-alloc-${row.slot_id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}

            <AddSlotRow
              slots={slots}
              existingSlotIds={new Set(allocations.map((a) => a.slot_id))}
              onAdd={(payload) =>
                upsertMutation.mutate({
                  scope_type: scopeType,
                  scope_ref_id: scopeRefId,
                  ...payload,
                  is_active: true,
                })
              }
            />

            <div
              className="flex gap-3 text-xs pt-2 border-t"
              data-testid="alloc-totals"
            >
              <Badge variant="secondary">Mandatory: {totals.mandatory}</Badge>
              <Badge variant="secondary">Conditional: {totals.conditional}</Badge>
              <Badge variant="secondary">Free rec: {totals.freeRec}</Badge>
              <Badge variant="outline">Total: {totals.total}</Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {scopeType === "package" && selectedPackage && (
        <ToleranceCard
          pkg={selectedPackage}
          globalDefaults={tolDefaultsQuery.data || { below: 3, above: 3 }}
          onSave={(below, above) =>
            tolMutation.mutate({ packageId: selectedPackage.id, below, above })
          }
        />
      )}

      {scopeRefId && previewEntries.length > 0 && (
        <Card data-testid="resolved-preview">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Resolved recipe preview</CardTitle>
            <CardDescription className="text-xs">
              What this scope would resolve to in isolation. The ingest
              resolver merges with project_type / package / individual product
              scopes at round time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-xs text-muted-foreground">
              Synthetic combo: {scopeType} · {previewEntries.length} slots ·{" "}
              total min {previewEntries.reduce((acc, e) => acc + e.allocated_count, 0)} ·{" "}
              total max {previewEntries.reduce((acc, e) => acc + e.max_count, 0)}
            </div>
            <div className="grid grid-cols-12 gap-1 text-xs font-medium">
              <div className="col-span-4">Slot</div>
              <div className="col-span-3">Class</div>
              <div className="col-span-1">Count</div>
              <div className="col-span-1">Max</div>
              <div className="col-span-1">Rank</div>
            </div>
            {previewEntries.map((e) => (
              <div
                key={`preview-${e.slot_id}`}
                className="grid grid-cols-12 gap-1 text-xs"
              >
                <div className="col-span-4">{e.slot_id}</div>
                <div className="col-span-3">{e.classification}</div>
                <div className="col-span-1">{e.allocated_count}</div>
                <div className="col-span-1">{e.max_count}</div>
                <div className="col-span-1">{e.priority_rank}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AddSlotRow({ slots, existingSlotIds, onAdd }) {
  const [slotId, setSlotId] = useState(null);
  const [classification, setClassification] = useState("conditional");
  const [count, setCount] = useState("1");

  const available = slots.filter((s) => !existingSlotIds.has(s.slot_id));
  return (
    <div
      className="grid grid-cols-12 gap-2 items-end pt-2 border-t"
      data-testid="add-slot-row"
    >
      <div className="col-span-4">
        <Label className="text-xs">Add slot</Label>
        <Select value={slotId || ""} onValueChange={setSlotId}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Pick slot…" />
          </SelectTrigger>
          <SelectContent>
            {available.map((s) => (
              <SelectItem key={s.slot_id} value={s.slot_id}>
                {s.slot_id} (phase {s.phase})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="col-span-3">
        <Label className="text-xs">Class</Label>
        <Select value={classification} onValueChange={setClassification}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLASSIFICATIONS.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="col-span-2">
        <Label className="text-xs">Count</Label>
        <Input
          type="number"
          className="h-7 text-xs"
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
      </div>
      <div className="col-span-3">
        <Button
          size="sm"
          className="h-7 w-full"
          disabled={!slotId}
          onClick={() => {
            onAdd({
              slot_id: slotId,
              classification,
              allocated_count: Number(count) || 0,
              max_count: null,
              priority_rank: 100,
              notes: null,
            });
            setSlotId(null);
            setCount("1");
          }}
          data-testid="add-slot-submit"
        >
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}

function ToleranceCard({ pkg, globalDefaults, onSave }) {
  const [below, setBelow] = useState(
    pkg.expected_count_tolerance_below === null || pkg.expected_count_tolerance_below === undefined
      ? ""
      : String(pkg.expected_count_tolerance_below),
  );
  const [above, setAbove] = useState(
    pkg.expected_count_tolerance_above === null || pkg.expected_count_tolerance_above === undefined
      ? ""
      : String(pkg.expected_count_tolerance_above),
  );

  return (
    <Card data-testid="tolerance-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Tolerance — this package</CardTitle>
        <CardDescription className="text-xs">
          Per-package override for the recipe sum-vs-target validation.
          Leave blank to inherit the global default ({globalDefaults.below}/
          {globalDefaults.above}).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2 items-end">
        <div className="flex-1">
          <Label className="text-xs">Below target</Label>
          <Input
            type="number"
            className="h-7 text-xs"
            placeholder={`global: ${globalDefaults.below}`}
            value={below}
            onChange={(e) => setBelow(e.target.value)}
            data-testid="tolerance-below"
          />
        </div>
        <div className="flex-1">
          <Label className="text-xs">Above target</Label>
          <Input
            type="number"
            className="h-7 text-xs"
            placeholder={`global: ${globalDefaults.above}`}
            value={above}
            onChange={(e) => setAbove(e.target.value)}
            data-testid="tolerance-above"
          />
        </div>
        <Button
          size="sm"
          className="h-7"
          onClick={() => onSave(below, above)}
          data-testid="tolerance-save"
        >
          <Save className="h-3 w-3 mr-1" /> Save
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * SettingsShortlistingSlots — Wave 6 Phase 7 SHORTLIST
 *
 * Admin editor for `shortlisting_slot_definitions`. master_admin only.
 *
 * Versioning contract (per the build brief):
 *   When the admin saves a change, INSERT a new row with
 *   version = MAX(version_for_slot_id) + 1 and is_active = true, then
 *   UPDATE the prior active row to is_active = false. We NEVER mutate
 *   the descriptor of an existing row in place — preserves audit history.
 *
 * Validation:
 *   - phase ∈ {1, 2}  (3 is "free" / unbounded — not represented in the
 *     slot definitions table; we only allow 1 or 2 here).
 *   - max_images >= min_images >= 0
 *   - package_types non-empty
 *   - eligible_room_types non-empty
 *   - display_name non-empty
 *
 * Filters: phase (1 / 2 / all), package (Gold / Day to Dusk / Premium /
 * all), is_active toggle.
 */

import { useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Layers,
  Loader2,
  Pencil,
  Plus,
  Save,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Constants ───────────────────────────────────────────────────────────────
const PACKAGE_OPTIONS = ["Gold", "Day to Dusk", "Premium"];

// Common eligible_room_types autocomplete suggestions, derived from the
// seeded slot definitions. The DB doesn't enforce a fixed enum, so the
// list is suggestion-only — admins can type any room key.
const ROOM_TYPE_SUGGESTIONS = [
  "exterior_front",
  "exterior_rear",
  "kitchen_main",
  "master_bedroom",
  "bedroom_secondary",
  "interior_open_plan",
  "living_room",
  "living_secondary",
  "dining_room",
  "alfresco",
  "bathroom",
  "ensuite_primary",
  "study_office",
  "laundry",
];

const PHASE_LABELS = {
  1: { label: "P1 mandatory", tone: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300" },
  2: { label: "P2 conditional", tone: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" },
};

// ── Form helpers ────────────────────────────────────────────────────────────
function emptyForm() {
  return {
    slot_id: "",
    display_name: "",
    phase: 2,
    package_types: [...PACKAGE_OPTIONS],
    eligible_room_types: [],
    max_images: 1,
    min_images: 0,
    notes: "",
  };
}

function validateForm(form, isNew, existingSlotIds) {
  const errors = {};
  if (!form.slot_id || !/^[a-z0-9_]+$/i.test(form.slot_id)) {
    errors.slot_id = "Required. Lowercase letters, digits, underscores only.";
  } else if (isNew && existingSlotIds.has(form.slot_id)) {
    errors.slot_id = "A slot with this ID already exists.";
  }
  if (!form.display_name || !form.display_name.trim()) {
    errors.display_name = "Display name is required.";
  }
  if (![1, 2].includes(Number(form.phase))) {
    errors.phase = "Phase must be 1 (mandatory) or 2 (conditional).";
  }
  if (!Array.isArray(form.package_types) || form.package_types.length === 0) {
    errors.package_types = "Pick at least one package type.";
  }
  if (
    !Array.isArray(form.eligible_room_types) ||
    form.eligible_room_types.length === 0
  ) {
    errors.eligible_room_types = "Pick at least one eligible room type.";
  }
  const minN = Number(form.min_images);
  const maxN = Number(form.max_images);
  if (!Number.isInteger(minN) || minN < 0)
    errors.min_images = "Must be a non-negative integer.";
  if (!Number.isInteger(maxN) || maxN < 1)
    errors.max_images = "Must be ≥ 1.";
  if (
    Number.isInteger(minN) &&
    Number.isInteger(maxN) &&
    minN > maxN
  ) {
    errors.max_images = "max_images must be ≥ min_images.";
  }
  return errors;
}

// ── Multiselect chips (lightweight, no extra primitive) ─────────────────────
function ChipMultiselect({ value, onChange, options, placeholder }) {
  const [draft, setDraft] = useState("");
  const arr = Array.isArray(value) ? value : [];

  const addRaw = (raw) => {
    const v = (raw || "").trim();
    if (!v) return;
    if (arr.includes(v)) return;
    onChange([...arr, v]);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1 min-h-[28px]">
        {arr.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded bg-muted text-xs px-2 py-0.5"
          >
            <span className="font-mono">{v}</span>
            <button
              type="button"
              onClick={() => onChange(arr.filter((x) => x !== v))}
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${v}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRaw(draft);
              setDraft("");
            }
          }}
          placeholder={placeholder}
          className="h-8 text-xs flex-1"
          list={options ? `chip-options-${placeholder}` : undefined}
        />
        {options && (
          <datalist id={`chip-options-${placeholder}`}>
            {options
              .filter((o) => !arr.includes(o))
              .map((o) => (
                <option key={o} value={o} />
              ))}
          </datalist>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (draft.trim()) {
              addRaw(draft);
              setDraft("");
            }
          }}
          className="h-8 text-xs"
        >
          Add
        </Button>
      </div>
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {options
            .filter((o) => !arr.includes(o))
            .map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => onChange([...arr, o])}
                className="text-[10px] rounded border border-dashed border-border/60 px-1.5 py-0.5 hover:bg-muted/40 font-mono text-muted-foreground"
              >
                + {o}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function PackageMultiselect({ value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const toggle = (p) => {
    if (arr.includes(p)) onChange(arr.filter((x) => x !== p));
    else onChange([...arr, p]);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {PACKAGE_OPTIONS.map((p) => {
        const on = arr.includes(p);
        return (
          <button
            key={p}
            type="button"
            onClick={() => toggle(p)}
            className={cn(
              "text-xs rounded-md border px-2.5 py-1 transition-colors",
              on
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-muted/40 border-border",
            )}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

// ── Edit modal ──────────────────────────────────────────────────────────────
function EditSlotDialog({
  open,
  onOpenChange,
  initialForm,
  isNew,
  existingSlotIds,
  onSave,
  isSaving,
  currentVersion,
}) {
  const [form, setForm] = useState(initialForm);
  const errors = useMemo(
    () => validateForm(form, isNew, existingSlotIds),
    [form, isNew, existingSlotIds],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = () => {
    if (hasErrors) {
      toast.error("Fix validation errors before saving.");
      return;
    }
    onSave(form);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "New slot definition" : "Edit slot definition"}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? "Creating a brand-new slot. Version will start at 1."
              : `Saving will deactivate v${currentVersion} and create v${(currentVersion ?? 0) + 1}. The descriptor for the prior version is preserved as audit history.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Slot ID</Label>
              <Input
                value={form.slot_id}
                onChange={(e) => update("slot_id", e.target.value)}
                disabled={!isNew}
                placeholder="e.g. kitchen_hero"
                className="h-9 text-xs font-mono"
              />
              {errors.slot_id && (
                <p className="text-[10px] text-red-600">{errors.slot_id}</p>
              )}
              {!isNew && (
                <p className="text-[10px] text-muted-foreground">
                  slot_id is immutable across versions.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Display name</Label>
              <Input
                value={form.display_name}
                onChange={(e) => update("display_name", e.target.value)}
                placeholder="e.g. Kitchen — hero"
                className="h-9 text-xs"
              />
              {errors.display_name && (
                <p className="text-[10px] text-red-600">{errors.display_name}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Phase</Label>
              <Select
                value={String(form.phase)}
                onValueChange={(v) => update("phase", Number(v))}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 — Mandatory</SelectItem>
                  <SelectItem value="2">2 — Conditional</SelectItem>
                </SelectContent>
              </Select>
              {errors.phase && (
                <p className="text-[10px] text-red-600">{errors.phase}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Min images</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={form.min_images}
                onChange={(e) =>
                  update("min_images", parseInt(e.target.value, 10) || 0)
                }
                className="h-9 text-xs"
              />
              {errors.min_images && (
                <p className="text-[10px] text-red-600">{errors.min_images}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Max images</Label>
              <Input
                type="number"
                min={1}
                step={1}
                value={form.max_images}
                onChange={(e) =>
                  update("max_images", parseInt(e.target.value, 10) || 1)
                }
                className="h-9 text-xs"
              />
              {errors.max_images && (
                <p className="text-[10px] text-red-600">{errors.max_images}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Package types</Label>
            <PackageMultiselect
              value={form.package_types}
              onChange={(v) => update("package_types", v)}
            />
            {errors.package_types && (
              <p className="text-[10px] text-red-600">{errors.package_types}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Eligible room types</Label>
            <ChipMultiselect
              value={form.eligible_room_types}
              onChange={(v) => update("eligible_room_types", v)}
              options={ROOM_TYPE_SUGGESTIONS}
              placeholder="e.g. kitchen_main"
            />
            {errors.eligible_room_types && (
              <p className="text-[10px] text-red-600">
                {errors.eligible_room_types}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              value={form.notes || ""}
              onChange={(e) => update("notes", e.target.value)}
              placeholder="Reasoning, tuning notes, edge cases…"
              rows={3}
              className="text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || hasErrors}>
            {isSaving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {isNew ? "Create" : "Save new version"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function SettingsShortlistingSlots() {
  const queryClient = useQueryClient();
  const [phaseFilter, setPhaseFilter] = useState("all");
  const [packageFilter, setPackageFilter] = useState("all");
  const [activeOnly, setActiveOnly] = useState(true);
  const [editorState, setEditorState] = useState({
    open: false,
    isNew: false,
    initialForm: emptyForm(),
    currentVersion: 1,
    editingSlotId: null,
  });

  // Load all rows (active + history). The page filters client-side so the
  // history feature can use the same data.
  const slotsQuery = useQuery({
    queryKey: ["shortlisting_slot_definitions_all"],
    queryFn: () =>
      api.entities.ShortlistingSlotDefinition.list("-created_at", 500),
  });

  const allRows = slotsQuery.data || [];
  const activeRows = useMemo(
    () => allRows.filter((r) => r.is_active === true),
    [allRows],
  );

  // Group by slot_id to find the current active version + version count.
  const bySlotId = useMemo(() => {
    const m = new Map();
    for (const r of allRows) {
      if (!m.has(r.slot_id)) m.set(r.slot_id, []);
      m.get(r.slot_id).push(r);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    }
    return m;
  }, [allRows]);

  const existingSlotIds = useMemo(
    () => new Set(allRows.map((r) => r.slot_id)),
    [allRows],
  );

  const filtered = useMemo(() => {
    const baseRows = activeOnly ? activeRows : allRows;
    return baseRows.filter((r) => {
      if (phaseFilter !== "all" && String(r.phase) !== phaseFilter) return false;
      if (packageFilter !== "all") {
        const pkgs = Array.isArray(r.package_types) ? r.package_types : [];
        if (!pkgs.includes(packageFilter)) return false;
      }
      return true;
    });
  }, [activeRows, allRows, phaseFilter, packageFilter, activeOnly]);

  // ── Save mutation: insert new + deactivate old (atomic-ish) ─────────────
  const saveMutation = useMutation({
    mutationFn: async ({ form, isNew, currentRow }) => {
      if (isNew) {
        return await api.entities.ShortlistingSlotDefinition.create({
          slot_id: form.slot_id,
          display_name: form.display_name.trim(),
          phase: Number(form.phase),
          package_types: form.package_types,
          eligible_room_types: form.eligible_room_types,
          max_images: Number(form.max_images),
          min_images: Number(form.min_images),
          notes: form.notes?.trim() || null,
          version: 1,
          is_active: true,
        });
      }

      // Insert NEW row for the same slot_id with version+1.
      const nextVersion = (currentRow?.version ?? 0) + 1;
      const newRow = await api.entities.ShortlistingSlotDefinition.create({
        slot_id: form.slot_id,
        display_name: form.display_name.trim(),
        phase: Number(form.phase),
        package_types: form.package_types,
        eligible_room_types: form.eligible_room_types,
        max_images: Number(form.max_images),
        min_images: Number(form.min_images),
        notes: form.notes?.trim() || null,
        version: nextVersion,
        is_active: true,
      });

      // Deactivate previous active row.
      if (currentRow?.id) {
        try {
          await api.entities.ShortlistingSlotDefinition.update(currentRow.id, {
            is_active: false,
          });
        } catch (err) {
          // Roll back the inserted row to keep the table consistent.
          try {
            await api.entities.ShortlistingSlotDefinition.delete(newRow.id);
          } catch {
            /* ignore — at least we'll alert */
          }
          throw new Error(
            `Failed to deactivate previous version: ${err.message}`,
          );
        }
      }

      return newRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_slot_definitions_all"],
      });
      setEditorState({
        open: false,
        isNew: false,
        initialForm: emptyForm(),
        currentVersion: 1,
        editingSlotId: null,
      });
      toast.success("Slot saved — new version active.");
    },
    onError: (err) => toast.error(`Save failed: ${err.message}`),
  });

  // ── Toggle is_active (deactivate / re-enable) ───────────────────────────
  const toggleActiveMutation = useMutation({
    mutationFn: async ({ row, nextActive }) => {
      // If we're activating a row, deactivate any sibling that's also active
      // (only one active version per slot_id).
      if (nextActive) {
        const siblings = (bySlotId.get(row.slot_id) || []).filter(
          (r) => r.id !== row.id && r.is_active,
        );
        for (const s of siblings) {
          await api.entities.ShortlistingSlotDefinition.update(s.id, {
            is_active: false,
          });
        }
      }
      return await api.entities.ShortlistingSlotDefinition.update(row.id, {
        is_active: nextActive,
      });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_slot_definitions_all"],
      });
      toast.success(
        vars.nextActive ? "Slot activated." : "Slot deactivated.",
      );
    },
    onError: (err) => toast.error(`Toggle failed: ${err.message}`),
  });

  const openEditor = useCallback(
    (row) => {
      setEditorState({
        open: true,
        isNew: false,
        initialForm: {
          slot_id: row.slot_id,
          display_name: row.display_name || "",
          phase: row.phase || 2,
          package_types: Array.isArray(row.package_types)
            ? [...row.package_types]
            : [],
          eligible_room_types: Array.isArray(row.eligible_room_types)
            ? [...row.eligible_room_types]
            : [],
          max_images: row.max_images ?? 1,
          min_images: row.min_images ?? 0,
          notes: row.notes || "",
        },
        currentVersion: row.version || 1,
        editingSlotId: row.slot_id,
      });
    },
    [],
  );

  const openCreator = useCallback(() => {
    setEditorState({
      open: true,
      isNew: true,
      initialForm: emptyForm(),
      currentVersion: 0,
      editingSlotId: null,
    });
  }, []);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8 max-w-[1280px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Layers className="h-6 w-6 text-primary" />
              Slot Taxonomy
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {activeRows.length} active slot
              {activeRows.length === 1 ? "" : "s"} configure how the engine fills
              the shortlist per package. Edits create a new version — prior
              versions are preserved.
            </p>
          </div>
          <Button onClick={openCreator}>
            <Plus className="h-4 w-4 mr-1.5" />
            New slot
          </Button>
        </div>

        {/* Filter row */}
        <Card>
          <CardContent className="p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Phase
                </Label>
                <Select value={phaseFilter} onValueChange={setPhaseFilter}>
                  <SelectTrigger className="h-9 w-[170px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All phases</SelectItem>
                    <SelectItem value="1">P1 mandatory</SelectItem>
                    <SelectItem value="2">P2 conditional</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Package
                </Label>
                <Select value={packageFilter} onValueChange={setPackageFilter}>
                  <SelectTrigger className="h-9 w-[180px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All packages</SelectItem>
                    {PACKAGE_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Active only
                </Label>
                <div className="h-9 flex items-center">
                  <Switch
                    checked={activeOnly}
                    onCheckedChange={setActiveOnly}
                  />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {activeOnly ? "Hiding history" : "Showing history"}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Slots list */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Slots</CardTitle>
            <CardDescription className="text-xs">
              {filtered.length} match{filtered.length === 1 ? "" : "es"}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {slotsQuery.isLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : slotsQuery.error ? (
              <div className="p-4 text-xs text-red-600">
                Failed to load: {slotsQuery.error.message}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-xs text-muted-foreground italic text-center">
                No slots match the current filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Slot ID</th>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Phase</th>
                      <th className="px-3 py-2 font-medium">Packages</th>
                      <th className="px-3 py-2 font-medium">Room types</th>
                      <th className="px-3 py-2 font-medium tabular-nums">Min/Max</th>
                      <th className="px-3 py-2 font-medium tabular-nums">v</th>
                      <th className="px-3 py-2 font-medium">Active</th>
                      <th className="px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => {
                      const phaseInfo =
                        PHASE_LABELS[row.phase] || { label: `P${row.phase}`, tone: "" };
                      const rooms = Array.isArray(row.eligible_room_types)
                        ? row.eligible_room_types
                        : [];
                      const pkgs = Array.isArray(row.package_types)
                        ? row.package_types
                        : [];
                      return (
                        <tr
                          key={row.id}
                          className={cn(
                            "border-b last:border-0 hover:bg-muted/30",
                            !row.is_active && "opacity-60",
                          )}
                        >
                          <td className="px-3 py-2 font-mono text-[11px]">
                            {row.slot_id}
                          </td>
                          <td className="px-3 py-2">{row.display_name}</td>
                          <td className="px-3 py-2">
                            <Badge
                              variant="secondary"
                              className={cn("text-[10px]", phaseInfo.tone)}
                            >
                              {phaseInfo.label}
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {pkgs.map((p) => (
                                <Badge
                                  key={p}
                                  variant="outline"
                                  className="text-[9px]"
                                >
                                  {p}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td
                            className="px-3 py-2 max-w-[260px]"
                            title={rooms.join(", ")}
                          >
                            <span className="text-[11px] font-mono truncate inline-block max-w-[260px]">
                              {rooms.slice(0, 3).join(", ")}
                              {rooms.length > 3 ? ` +${rooms.length - 3}` : ""}
                            </span>
                          </td>
                          <td className="px-3 py-2 tabular-nums text-[11px]">
                            {row.min_images}/{row.max_images}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{row.version}</td>
                          <td className="px-3 py-2">
                            <Switch
                              checked={row.is_active === true}
                              onCheckedChange={(v) =>
                                toggleActiveMutation.mutate({
                                  row,
                                  nextActive: v,
                                })
                              }
                              disabled={toggleActiveMutation.isPending}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => openEditor(row)}
                              disabled={!row.is_active}
                              title={
                                row.is_active
                                  ? "Edit (creates a new version)"
                                  : "Activate this row to edit it"
                              }
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {editorState.open && (
          <EditSlotDialog
            open={editorState.open}
            onOpenChange={(o) =>
              setEditorState((s) => ({ ...s, open: o }))
            }
            initialForm={editorState.initialForm}
            isNew={editorState.isNew}
            existingSlotIds={existingSlotIds}
            currentVersion={editorState.currentVersion}
            isSaving={saveMutation.isPending}
            onSave={(form) => {
              const currentRow = editorState.editingSlotId
                ? (bySlotId.get(editorState.editingSlotId) || []).find(
                    (r) => r.is_active,
                  )
                : null;
              saveMutation.mutate({
                form,
                isNew: editorState.isNew,
                currentRow,
              });
            }}
          />
        )}
      </div>
    </PermissionGuard>
  );
}

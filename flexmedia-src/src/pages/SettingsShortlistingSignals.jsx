/**
 * SettingsShortlistingSignals — Wave 6 Phase 7 SHORTLIST
 *
 * Admin editor for `shortlisting_signal_weights`. master_admin only.
 *
 * Versioning contract (insert-new + deactivate-old) matches Slots and
 * Standards. Signal_key is immutable across versions; weight,
 * per_room_modifiers, description, and dimension are editable.
 *
 * Validation:
 *   - weight: 0.0 ≤ w ≤ 2.0 (slider)
 *   - per_room_modifiers: must parse as a JSON object whose values are
 *     finite numbers (used by the engine as multipliers).
 *   - signal_key: lowercase letters/digits/underscores, immutable on edit.
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
import { Slider } from "@/components/ui/slider";
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
  Gauge,
  Loader2,
  Pencil,
  Plus,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Constants ───────────────────────────────────────────────────────────────
const DIMENSIONS = ["compositional", "aesthetic", "technical", "lighting"];

const DIMENSION_TONE = {
  compositional:
    "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  aesthetic:
    "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300",
  technical:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  lighting:
    "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
};

// ── Form helpers ────────────────────────────────────────────────────────────
function emptyForm() {
  return {
    signal_key: "",
    dimension: "compositional",
    weight: 1.0,
    per_room_modifiers_json: "{}",
    description: "",
  };
}

function rowToForm(row) {
  return {
    signal_key: row.signal_key,
    dimension: row.dimension || "compositional",
    weight: Number(row.weight ?? 1.0),
    per_room_modifiers_json: row.per_room_modifiers
      ? JSON.stringify(row.per_room_modifiers, null, 2)
      : "{}",
    description: row.description || "",
  };
}

function validateForm(form, isNew, existingKeys) {
  const errors = {};
  if (!form.signal_key || !/^[a-z0-9_]+$/.test(form.signal_key)) {
    errors.signal_key =
      "Required. Lowercase letters, digits, underscores only.";
  } else if (isNew && existingKeys.has(form.signal_key)) {
    errors.signal_key = "A signal with this key already exists.";
  }
  if (!DIMENSIONS.includes(form.dimension)) {
    errors.dimension = `Must be one of: ${DIMENSIONS.join(", ")}.`;
  }
  const w = Number(form.weight);
  if (!isFinite(w) || w < 0 || w > 2) {
    errors.weight = "Weight must be between 0.0 and 2.0.";
  }
  // JSON validation for per_room_modifiers
  let parsed = null;
  try {
    parsed = JSON.parse(form.per_room_modifiers_json || "{}");
  } catch (e) {
    errors.per_room_modifiers_json = `Invalid JSON: ${e.message}`;
  }
  if (parsed !== null) {
    if (
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed === null
    ) {
      errors.per_room_modifiers_json =
        "Must be a JSON object (e.g. { \"kitchen\": 1.4 }).";
    } else {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "number" || !isFinite(v)) {
          errors.per_room_modifiers_json = `Value for "${k}" must be a finite number.`;
          break;
        }
      }
    }
  }
  return { errors, parsedModifiers: parsed };
}

// ── Edit dialog ─────────────────────────────────────────────────────────────
function EditSignalDialog({
  open,
  onOpenChange,
  initialForm,
  isNew,
  existingKeys,
  currentVersion,
  onSave,
  isSaving,
}) {
  const [form, setForm] = useState(initialForm);
  const { errors, parsedModifiers } = useMemo(
    () => validateForm(form, isNew, existingKeys),
    [form, isNew, existingKeys],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = () => {
    if (hasErrors) {
      toast.error("Fix validation errors before saving.");
      return;
    }
    onSave({
      ...form,
      per_room_modifiers: parsedModifiers || {},
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "New signal" : "Edit signal"}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? "Creating a new signal. Version starts at 1."
              : `Saving will deactivate v${currentVersion} and create v${(currentVersion ?? 0) + 1}. The descriptor for the prior version is preserved.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Signal key</Label>
              <Input
                value={form.signal_key}
                onChange={(e) => update("signal_key", e.target.value)}
                disabled={!isNew}
                placeholder="e.g. living_zone_count"
                className="h-9 text-xs font-mono"
              />
              {errors.signal_key && (
                <p className="text-[10px] text-red-600">{errors.signal_key}</p>
              )}
              {!isNew && (
                <p className="text-[10px] text-muted-foreground">
                  signal_key is immutable across versions.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Dimension</Label>
              <Select
                value={form.dimension}
                onValueChange={(v) => update("dimension", v)}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIMENSIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.dimension && (
                <p className="text-[10px] text-red-600">{errors.dimension}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Weight</Label>
              <span className="text-xs font-mono tabular-nums">
                {Number(form.weight).toFixed(2)}
              </span>
            </div>
            <Slider
              value={[Number(form.weight)]}
              min={0}
              max={2}
              step={0.05}
              onValueChange={([v]) => update("weight", v)}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>0.0</span>
              <span>1.0 (neutral)</span>
              <span>2.0</span>
            </div>
            {errors.weight && (
              <p className="text-[10px] text-red-600">{errors.weight}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Per-room modifiers (JSON)</Label>
            <Textarea
              value={form.per_room_modifiers_json}
              onChange={(e) => update("per_room_modifiers_json", e.target.value)}
              rows={6}
              placeholder='{"kitchen_main": 1.4, "living_room": 1.4}'
              className="font-mono text-[11px]"
            />
            {errors.per_room_modifiers_json ? (
              <p className="text-[10px] text-red-600">
                {errors.per_room_modifiers_json}
              </p>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                Multipliers applied to this signal per room type. Empty object
                means no per-room weighting.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              rows={4}
              placeholder="What does this signal measure? Scoring guidance for the engine."
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
export default function SettingsShortlistingSignals() {
  const queryClient = useQueryClient();
  const [dimensionFilter, setDimensionFilter] = useState("all");
  const [activeOnly, setActiveOnly] = useState(true);
  const [editorState, setEditorState] = useState({
    open: false,
    isNew: false,
    initialForm: emptyForm(),
    currentVersion: 1,
    editingKey: null,
  });

  const signalsQuery = useQuery({
    queryKey: ["shortlisting_signal_weights_all"],
    queryFn: () =>
      api.entities.ShortlistingSignalWeight.list("-created_at", 500),
  });

  const allRows = signalsQuery.data || [];
  const activeRows = useMemo(
    () => allRows.filter((r) => r.is_active === true),
    [allRows],
  );

  const byKey = useMemo(() => {
    const m = new Map();
    for (const r of allRows) {
      if (!m.has(r.signal_key)) m.set(r.signal_key, []);
      m.get(r.signal_key).push(r);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    }
    return m;
  }, [allRows]);

  const existingKeys = useMemo(
    () => new Set(allRows.map((r) => r.signal_key)),
    [allRows],
  );

  const filtered = useMemo(() => {
    const baseRows = activeOnly ? activeRows : allRows;
    return baseRows.filter((r) => {
      if (dimensionFilter !== "all" && r.dimension !== dimensionFilter)
        return false;
      return true;
    });
  }, [activeRows, allRows, dimensionFilter, activeOnly]);

  const saveMutation = useMutation({
    mutationFn: async ({ form, isNew, currentRow }) => {
      const payload = {
        signal_key: form.signal_key,
        dimension: form.dimension,
        weight: Number(form.weight),
        per_room_modifiers: form.per_room_modifiers || {},
        description: form.description?.trim() || null,
        is_active: true,
      };
      if (isNew) {
        return await api.entities.ShortlistingSignalWeight.create({
          ...payload,
          version: 1,
        });
      }
      const nextVersion = (currentRow?.version ?? 0) + 1;
      const newRow = await api.entities.ShortlistingSignalWeight.create({
        ...payload,
        version: nextVersion,
      });
      if (currentRow?.id) {
        try {
          await api.entities.ShortlistingSignalWeight.update(currentRow.id, {
            is_active: false,
          });
        } catch (err) {
          try {
            await api.entities.ShortlistingSignalWeight.delete(newRow.id);
          } catch {
            /* ignore */
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
        queryKey: ["shortlisting_signal_weights_all"],
      });
      setEditorState({
        open: false,
        isNew: false,
        initialForm: emptyForm(),
        currentVersion: 1,
        editingKey: null,
      });
      toast.success("Signal saved — new version active.");
    },
    onError: (err) => toast.error(`Save failed: ${err.message}`),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ row, nextActive }) => {
      if (nextActive) {
        const siblings = (byKey.get(row.signal_key) || []).filter(
          (r) => r.id !== row.id && r.is_active,
        );
        for (const s of siblings) {
          await api.entities.ShortlistingSignalWeight.update(s.id, {
            is_active: false,
          });
        }
      }
      return await api.entities.ShortlistingSignalWeight.update(row.id, {
        is_active: nextActive,
      });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_signal_weights_all"],
      });
      toast.success(
        vars.nextActive ? "Signal activated." : "Signal deactivated.",
      );
    },
    onError: (err) => toast.error(`Toggle failed: ${err.message}`),
  });

  const openEditor = useCallback((row) => {
    setEditorState({
      open: true,
      isNew: false,
      initialForm: rowToForm(row),
      currentVersion: row.version || 1,
      editingKey: row.signal_key,
    });
  }, []);

  const openCreator = useCallback(() => {
    setEditorState({
      open: true,
      isNew: true,
      initialForm: emptyForm(),
      currentVersion: 0,
      editingKey: null,
    });
  }, []);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8 max-w-[1280px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Gauge className="h-6 w-6 text-primary" />
              Signal Library
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {activeRows.length} active signal
              {activeRows.length === 1 ? "" : "s"} drive composition scoring.
              Edits create a new version — prior versions are preserved.
            </p>
          </div>
          <Button onClick={openCreator}>
            <Plus className="h-4 w-4 mr-1.5" />
            New signal
          </Button>
        </div>

        {/* Filter row */}
        <Card>
          <CardContent className="p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Dimension
                </Label>
                <Select
                  value={dimensionFilter}
                  onValueChange={setDimensionFilter}
                >
                  <SelectTrigger className="h-9 w-[180px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All dimensions</SelectItem>
                    {DIMENSIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
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

        {/* Signals list */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Signals</CardTitle>
            <CardDescription className="text-xs">
              {filtered.length} match{filtered.length === 1 ? "" : "es"}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {signalsQuery.isLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : signalsQuery.error ? (
              <div className="p-4 text-xs text-red-600">
                Failed to load: {signalsQuery.error.message}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-xs text-muted-foreground italic text-center">
                No signals match the current filters.
              </div>
            ) : (
              <ul className="divide-y">
                {filtered.map((row) => {
                  const tone =
                    DIMENSION_TONE[row.dimension] ||
                    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
                  const modifiersCount = row.per_room_modifiers
                    ? Object.keys(row.per_room_modifiers).length
                    : 0;
                  return (
                    <li
                      key={row.id}
                      className={cn(
                        "px-4 py-3 hover:bg-muted/30 text-xs",
                        !row.is_active && "opacity-60",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[12px] font-medium">
                              {row.signal_key}
                            </span>
                            <Badge
                              variant="secondary"
                              className={cn("text-[10px]", tone)}
                            >
                              {row.dimension}
                            </Badge>
                            <Badge
                              variant="outline"
                              className="text-[10px] tabular-nums"
                            >
                              weight {Number(row.weight).toFixed(2)}
                            </Badge>
                            {modifiersCount > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px]"
                                title={JSON.stringify(
                                  row.per_room_modifiers,
                                  null,
                                  2,
                                )}
                              >
                                {modifiersCount} room mod
                                {modifiersCount === 1 ? "" : "s"}
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className="text-[10px] tabular-nums"
                            >
                              v{row.version}
                            </Badge>
                          </div>
                          {row.description && (
                            <p
                              className="text-[11px] text-muted-foreground line-clamp-2"
                              title={row.description}
                            >
                              {row.description}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
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
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {editorState.open && (
          <EditSignalDialog
            open={editorState.open}
            onOpenChange={(o) =>
              setEditorState((s) => ({ ...s, open: o }))
            }
            initialForm={editorState.initialForm}
            isNew={editorState.isNew}
            existingKeys={existingKeys}
            currentVersion={editorState.currentVersion}
            isSaving={saveMutation.isPending}
            onSave={(form) => {
              const currentRow = editorState.editingKey
                ? (byKey.get(editorState.editingKey) || []).find(
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

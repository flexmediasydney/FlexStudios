/**
 * SettingsShortlistingRoomTypes — Wave 11.6.7 P1-3.
 *
 * Admin editor for `shortlisting_room_types`. master_admin only.
 *
 * Backs the dynamic Stage 1 prompt block
 * (`_shared/visionPrompts/blocks/roomTypesFromDb.ts`) — adding a row here +
 * waiting up to 60s for the in-memory cache to expire is enough for the next
 * Stage 1 run to pick it up. The static `roomTypeTaxonomy.ts` block is the
 * fallback when this table is empty or a DB read fails.
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
import { Home, Loader2, Pencil, Plus, Save, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const CATEGORY_OPTIONS = [
  "interior_living",
  "interior_private",
  "interior_circulation",
  "interior_special",
  "utility",
  "exterior_living",
  "exterior_facade",
  "aerial",
  "reference",
  "detail",
  "lifestyle",
];

const CATEGORY_TONE = {
  interior_living: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  interior_private: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  interior_circulation: "bg-slate-100 text-slate-700 dark:bg-slate-900/60 dark:text-slate-300",
  interior_special: "bg-pink-100 text-pink-700 dark:bg-pink-950/60 dark:text-pink-300",
  utility: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  exterior_living: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  exterior_facade: "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  aerial: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  reference: "bg-stone-100 text-stone-700 dark:bg-stone-900/60 dark:text-stone-300",
  detail: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  lifestyle: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
};

function emptyForm() {
  return {
    key: "",
    display_name: "",
    description: "",
    detection_hints: [],
    category: "interior_living",
    notes: "",
  };
}

function rowToForm(row) {
  return {
    key: row.key || "",
    display_name: row.display_name || "",
    description: row.description || "",
    detection_hints: Array.isArray(row.detection_hints) ? [...row.detection_hints] : [],
    category: row.category || "",
    notes: row.notes || "",
  };
}

function validateForm(form, isNew, existingKeys) {
  const errors = {};
  if (!form.key || !/^[a-z0-9_]+$/.test(form.key)) {
    errors.key = "Required. Lowercase letters, digits, underscores only.";
  } else if (isNew && existingKeys.has(form.key)) {
    errors.key = "A room type with this key already exists.";
  }
  if (!form.display_name || !form.display_name.trim()) {
    errors.display_name = "Display name is required.";
  }
  return errors;
}

function ChipMultiselect({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState("");
  const arr = Array.isArray(value) ? value : [];
  const addRaw = (raw) => {
    const v = (raw || "").trim();
    if (!v || arr.includes(v)) return;
    onChange([...arr, v]);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1 min-h-[28px]">
        {arr.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-muted text-xs px-2 py-0.5">
            <span className="font-mono">{v}</span>
            <button type="button" onClick={() => onChange(arr.filter((x) => x !== v))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${v}`}>
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
        />
        <Button type="button" size="sm" variant="outline" onClick={() => { if (draft.trim()) { addRaw(draft); setDraft(""); } }} className="h-8 text-xs">Add</Button>
      </div>
    </div>
  );
}

function EditRoomTypeDialog({ open, onOpenChange, initialForm, isNew, existingKeys, onSave, isSaving, currentVersion }) {
  const [form, setForm] = useState(initialForm);
  const errors = useMemo(() => validateForm(form, isNew, existingKeys), [form, isNew, existingKeys]);
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
          <DialogTitle>{isNew ? "New room type" : "Edit room type"}</DialogTitle>
          <DialogDescription>
            {isNew
              ? "Adding a new room type. Stage 1 picks it up on the next run after the 60s prompt cache expires."
              : `Saving updates the row in place — version bumps from v${currentVersion} to v${(currentVersion ?? 0) + 1}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Key</Label>
              <Input value={form.key} onChange={(e) => update("key", e.target.value)} disabled={!isNew} placeholder="e.g. wine_cellar_subterranean" className="h-9 text-xs font-mono" />
              {errors.key && <p className="text-[10px] text-red-600">{errors.key}</p>}
              {!isNew && <p className="text-[10px] text-muted-foreground">key is immutable — Pass 1 emits exactly this string.</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Display name</Label>
              <Input value={form.display_name} onChange={(e) => update("display_name", e.target.value)} placeholder="e.g. Wine cellar — subterranean" className="h-9 text-xs" />
              {errors.display_name && <p className="text-[10px] text-red-600">{errors.display_name}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Category</Label>
            <Select value={form.category} onValueChange={(v) => update("category", v)}>
              <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Pick a category" /></SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">Drives the category grouping in the Stage 1 prompt's reference list.</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea value={form.description} onChange={(e) => update("description", e.target.value)} rows={3} placeholder="When should this room type apply?" className="text-xs" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Detection hints</Label>
            <ChipMultiselect value={form.detection_hints} onChange={(v) => update("detection_hints", v)} placeholder="e.g. wine cellar" />
            <p className="text-[10px] text-muted-foreground">Optional words/phrases the prompt suggests as recognition cues.</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea value={form.notes || ""} onChange={(e) => update("notes", e.target.value)} rows={3} placeholder="Edge cases, tuning notes…" className="text-xs" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving || hasErrors}>
            {isSaving ? (<><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Saving…</>) : (<><Save className="h-3.5 w-3.5 mr-1.5" />{isNew ? "Create" : "Save"}</>)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsShortlistingRoomTypes() {
  const queryClient = useQueryClient();
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [activeOnly, setActiveOnly] = useState(true);
  const [editorState, setEditorState] = useState({
    open: false,
    isNew: false,
    initialForm: emptyForm(),
    currentVersion: 1,
    editingKey: null,
    editingId: null,
  });

  const roomTypesQuery = useQuery({
    queryKey: ["shortlisting_room_types_all"],
    queryFn: () => api.entities.ShortlistingRoomType.list("key", 500),
  });

  const allRows = roomTypesQuery.data || [];
  const activeRows = useMemo(() => allRows.filter((r) => r.is_active === true), [allRows]);
  const existingKeys = useMemo(() => new Set(allRows.map((r) => r.key)), [allRows]);

  const filtered = useMemo(() => {
    const baseRows = activeOnly ? activeRows : allRows;
    return baseRows.filter((r) => {
      if (categoryFilter !== "all" && r.category !== categoryFilter) return false;
      return true;
    });
  }, [activeRows, allRows, categoryFilter, activeOnly]);

  const saveMutation = useMutation({
    mutationFn: async ({ form, isNew, currentRow }) => {
      const payload = {
        key: form.key,
        display_name: form.display_name.trim(),
        description: form.description?.trim() || null,
        detection_hints: Array.isArray(form.detection_hints) ? form.detection_hints : [],
        category: form.category || null,
        notes: form.notes?.trim() || null,
      };
      if (isNew) {
        return await api.entities.ShortlistingRoomType.create({
          ...payload,
          version: 1,
          is_active: true,
        });
      }
      const nextVersion = (currentRow?.version ?? 0) + 1;
      return await api.entities.ShortlistingRoomType.update(currentRow.id, {
        ...payload,
        version: nextVersion,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shortlisting_room_types_all"] });
      setEditorState({ open: false, isNew: false, initialForm: emptyForm(), currentVersion: 1, editingKey: null, editingId: null });
      toast.success("Saved. Stage 1 picks up the change after the 60s prompt cache expires.");
    },
    onError: (err) => toast.error(`Save failed: ${err.message}`),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ row, nextActive }) =>
      await api.entities.ShortlistingRoomType.update(row.id, { is_active: nextActive }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["shortlisting_room_types_all"] });
      toast.success(vars.nextActive ? "Room type activated." : "Room type deactivated.");
    },
    onError: (err) => toast.error(`Toggle failed: ${err.message}`),
  });

  const openEditor = useCallback((row) => {
    setEditorState({
      open: true,
      isNew: false,
      initialForm: rowToForm(row),
      currentVersion: row.version || 1,
      editingKey: row.key,
      editingId: row.id,
    });
  }, []);

  const openCreator = useCallback(() => {
    setEditorState({ open: true, isNew: true, initialForm: emptyForm(), currentVersion: 0, editingKey: null, editingId: null });
  }, []);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8 max-w-[1280px] mx-auto space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Home className="h-6 w-6 text-primary" />
              Room Type Taxonomy
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {activeRows.length} active room type{activeRows.length === 1 ? "" : "s"}. Stage 1 emits one of these keys per composition. Edits propagate to the next prompt build (60s cache TTL). The static taxonomy in <code className="font-mono text-[11px]">roomTypeTaxonomy.ts</code> is the fallback when this table is empty or unreachable.
            </p>
          </div>
          <Button onClick={openCreator}><Plus className="h-4 w-4 mr-1.5" />New room type</Button>
        </div>

        <Card>
          <CardContent className="p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Category</Label>
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="h-9 w-[200px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {CATEGORY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Active only</Label>
                <div className="h-9 flex items-center">
                  <Switch checked={activeOnly} onCheckedChange={setActiveOnly} />
                  <span className="ml-2 text-xs text-muted-foreground">{activeOnly ? "Hiding inactive" : "Showing all"}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Room types</CardTitle>
            <CardDescription className="text-xs">{filtered.length} match{filtered.length === 1 ? "" : "es"}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {roomTypesQuery.isLoading ? (
              <div className="p-4 space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
            ) : roomTypesQuery.error ? (
              <div className="p-4 text-xs text-red-600">Failed to load: {roomTypesQuery.error.message}</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-xs text-muted-foreground italic text-center">No room types match the current filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Key</th>
                      <th className="px-3 py-2 font-medium">Display name</th>
                      <th className="px-3 py-2 font-medium">Category</th>
                      <th className="px-3 py-2 font-medium">Hints</th>
                      <th className="px-3 py-2 font-medium tabular-nums">v</th>
                      <th className="px-3 py-2 font-medium">Active</th>
                      <th className="px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => {
                      const hints = Array.isArray(row.detection_hints) ? row.detection_hints : [];
                      const tone = CATEGORY_TONE[row.category] || "";
                      return (
                        <tr key={row.id} className={cn("border-b last:border-0 hover:bg-muted/30", !row.is_active && "opacity-60")}>
                          <td className="px-3 py-2 font-mono text-[11px]">{row.key}</td>
                          <td className="px-3 py-2">{row.display_name}</td>
                          <td className="px-3 py-2">
                            {row.category ? (
                              <Badge variant="secondary" className={cn("text-[10px]", tone)}>{row.category}</Badge>
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 max-w-[260px]" title={hints.join(", ")}>
                            <span className="text-[11px] font-mono truncate inline-block max-w-[260px]">
                              {hints.slice(0, 3).join(", ")}{hints.length > 3 ? ` +${hints.length - 3}` : ""}
                            </span>
                          </td>
                          <td className="px-3 py-2 tabular-nums">{row.version}</td>
                          <td className="px-3 py-2">
                            <Switch
                              checked={row.is_active === true}
                              onCheckedChange={(v) => toggleActiveMutation.mutate({ row, nextActive: v })}
                              disabled={toggleActiveMutation.isPending}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openEditor(row)} title="Edit room type">
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
          <EditRoomTypeDialog
            open={editorState.open}
            onOpenChange={(o) => setEditorState((s) => ({ ...s, open: o }))}
            initialForm={editorState.initialForm}
            isNew={editorState.isNew}
            existingKeys={existingKeys}
            currentVersion={editorState.currentVersion}
            isSaving={saveMutation.isPending}
            onSave={(form) => {
              const currentRow = editorState.editingId ? allRows.find((r) => r.id === editorState.editingId) : null;
              saveMutation.mutate({ form, isNew: editorState.isNew, currentRow });
            }}
          />
        )}
      </div>
    </PermissionGuard>
  );
}

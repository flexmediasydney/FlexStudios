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
 *   - eligible_when_engine_roles non-empty (the sole eligibility key)
 *   - eligible_room_types non-empty
 *   - display_name non-empty
 *
 * Filters: phase (1 / 2 / all), is_active toggle.
 *
 * W11.6.5 (W7.11 cleanup): the legacy `package_types[]` array on slot rows
 * was the eligibility fallback during W7.7's transition window. Mig 339
 * dropped the column after W7.8 backfilled every active slot with
 * `eligible_when_engine_roles`. The form field, list filter, and table
 * column have been retired here so the admin UI mirrors the schema —
 * eligibility now flows exclusively through engine roles.
 */

import { useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Checkbox } from "@/components/ui/checkbox";
import {
  COMPOSITION_TYPE_OPTIONS,
  IMAGE_TYPE_OPTIONS,
  LIGHTING_STATE_OPTIONS,
  SPACE_TYPE_OPTIONS,
  UNIVERSAL_SIGNAL_KEYS,
  ZONE_FOCUS_OPTIONS,
} from "@/lib/shortlistingEnums";
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
  GripVertical,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Constants ───────────────────────────────────────────────────────────────
// Wave 7 P1-8: shortlisting engine roles. MUST match the migration 337
// backfill rules and supabase/functions/_shared/slotEligibility.ts ENGINE_ROLES.
// Drives the "Eligible when engine roles" multiselect — the resolver filters
// slots whose eligible_when_engine_roles overlaps the project's products'
// engine_role union. W11.6.5: this is the SOLE eligibility input — the
// legacy `package_types[]` fallback was retired with mig 339.
const ENGINE_ROLE_OPTIONS = [
  "photo_day_shortlist",
  "photo_dusk_shortlist",
  "drone_shortlist",
  "floorplan_qa",
  "video_day_shortlist",
  "video_dusk_shortlist",
  "agent_portraits",
];

// W11.6.7 P1-4: lens_class_constraint enum. Mirrors _shared/lensClass.ts
// LENS_CLASSES — keep in sync.
const LENS_CLASS_OPTIONS = [
  "wide_angle",
  "standard",
  "telephoto",
  "tilt_shift",
  "drone",
];

// W11.6.7 P1-5: common composition_type suggestions for the autocomplete chip
// multiselect. The DB doesn't enforce a fixed enum here either — admins can
// type any value. Mirror canonical compositions for hint quality.
const COMPOSITION_TYPE_SUGGESTIONS = [
  "hero_wide",
  "corner_two_point",
  "axial_one_point",
  "detail_corner",
  "detail_material",
  "compressed_telephoto",
  "elevated_overview",
  "lifestyle",
];

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

// W11.6.13 — orthogonal SPACE/ZONE taxonomies. Mirror the canonical
// taxonomies in supabase/functions/_shared/visionPrompts/blocks/
// spaceZoneTaxonomy.ts. Suggestion-only — admins can type any value;
// the engine resolver (slotEligibility.ts imageMatchesSlot) does
// case-sensitive includes() against whatever Stage 1 emits.
const SPACE_TYPE_SUGGESTIONS = [
  "master_bedroom",
  "bedroom_secondary",
  "bedroom_third",
  "living_dining_combined",
  "living_room_dedicated",
  "dining_room_dedicated",
  "kitchen_dining_living_combined",
  "kitchen_dedicated",
  "studio_open_plan",
  "bathroom",
  "ensuite",
  "powder_room",
  "entry_foyer",
  "hallway",
  "study",
  "media_room",
  "rumpus",
  "laundry",
  "mudroom",
  "garage",
  "alfresco_undercover",
  "alfresco_open",
  "balcony",
  "terrace",
  "exterior_facade",
  "exterior_rear",
  "exterior_side",
  "pool_area",
  "garden",
  "streetscape",
  "aerial_oblique",
  "aerial_nadir",
];
const ZONE_FOCUS_SUGGESTIONS = [
  "bed_focal",
  "wardrobe_built_in",
  "dining_table",
  "kitchen_island",
  "kitchen_appliance_wall",
  "kitchen_pantry",
  "lounge_seating",
  "fireplace_focal",
  "study_desk",
  "tv_media_wall",
  "bath_focal",
  "shower_focal",
  "vanity_detail",
  "toilet_visible",
  "window_view",
  "door_threshold",
  "stair_focal",
  "feature_wall",
  "ceiling_detail",
  "floor_detail",
  "material_proof",
  "landscape_overview",
  "full_facade",
  "pool_focal",
  "outdoor_dining",
  "outdoor_kitchen",
  "bbq_zone",
  "drying_zone",
  "parking_zone",
];

const PHASE_LABELS = {
  1: { label: "P1 mandatory", tone: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300" },
  2: { label: "P2 conditional", tone: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" },
};

// ── Form helpers ────────────────────────────────────────────────────────────
// W11.6.5: a fresh slot defaults to NO engine roles selected — the admin
// must explicitly pick at least one (validation enforces non-empty). The
// legacy `package_types` default has been removed along with the column.
function emptyForm() {
  return {
    slot_id: "",
    display_name: "",
    phase: 2,
    // W7.8 / W11.6.5: engine roles are now the sole eligibility input.
    // The slot is included for a round when ANY selected role overlaps the
    // project's products' engine roles. Validation requires at least one.
    eligible_when_engine_roles: [],
    eligible_room_types: [],
    // W11.6.13 — orthogonal SPACE/ZONE eligibility arrays. Empty defaults
    // (legacy slots fall back to eligible_room_types matching). Validation
    // does NOT require these — populating them is encouraged but optional
    // so existing rows continue to work without forced edits.
    eligible_space_types: [],
    eligible_zone_focuses: [],
    max_images: 1,
    min_images: 0,
    // W11.6.7 P1-4: optional lens_class constraint. Values: 'wide_angle' |
    //   'standard' | 'telephoto' | 'tilt_shift' | 'drone' | null.
    lens_class_constraint: null,
    // W11.6.7 P1-5: optional composition_type allow-list. NULL/empty = any.
    eligible_composition_types: [],
    // W11.6.7 P1-5: optional same-room linkage to another slot's id (UUID).
    same_room_as_slot: null,
    // W11.6.22: ai_decides (legacy default) | curated_positions.
    selection_mode: "ai_decides",
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
  // W11.6.5: engine roles are the sole eligibility input. A slot row with
  // is_active=true AND eligible_when_engine_roles=[] is considered
  // misconfigured by `_shared/slotEligibility.ts` and dropped at runtime —
  // enforce it here so the admin can't ship an unreachable slot.
  if (
    !Array.isArray(form.eligible_when_engine_roles) ||
    form.eligible_when_engine_roles.length === 0
  ) {
    errors.eligible_when_engine_roles =
      "Pick at least one engine role — this is the slot's eligibility key.";
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

// W7.8 / W11.6.5: chip multiselect over the engine_role enum. This is the
// sole eligibility input — selecting at least one role is mandatory (see
// validateForm). A slot whose roles overlap the round's resolved engine
// roles is included for that round.
function EngineRoleMultiselect({ value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const toggle = (r) => {
    if (arr.includes(r)) onChange(arr.filter((x) => x !== r));
    else onChange([...arr, r]);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {ENGINE_ROLE_OPTIONS.map((r) => {
        const on = arr.includes(r);
        return (
          <button
            key={r}
            type="button"
            onClick={() => toggle(r)}
            className={cn(
              "text-xs rounded-md border px-2.5 py-1 transition-colors font-mono",
              on
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-muted/40 border-border",
            )}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}

// ── W11.6.22b: Curated positions editor ─────────────────────────────────────
// One row per position. Drag-reorderable via @hello-pangea/dnd; the
// position_index is auto-managed from the array order at save time. Save
// flushes a transaction-style sequence: delete-removed → upsert-each.

function emptyPosition(nextIndex) {
  return {
    id: null,
    position_index: nextIndex,
    display_label: "",
    preferred_composition_type: null,
    preferred_zone_focus: null,
    preferred_space_type: null,
    preferred_lighting_state: null,
    preferred_image_type: null,
    preferred_signal_emphasis: [],
    is_required: false,
    // Default TRUE per Joseph's W11.6.22 default.
    ai_backfill_on_gap: true,
  };
}

function ChipSignalMultiselect({ value, onChange }) {
  const arr = Array.isArray(value) ? value : [];
  const toggle = (k) => {
    if (arr.includes(k)) onChange(arr.filter((x) => x !== k));
    else onChange([...arr, k]);
  };
  return (
    <div className="flex flex-wrap gap-1">
      {UNIVERSAL_SIGNAL_KEYS.map((k) => {
        const on = arr.includes(k);
        return (
          <button
            key={k}
            type="button"
            onClick={() => toggle(k)}
            className={cn(
              "text-[10px] rounded border px-1.5 py-0.5 font-mono transition-colors",
              on
                ? "bg-primary/90 text-primary-foreground border-primary"
                : "bg-background hover:bg-muted/40 border-border text-muted-foreground",
            )}
            data-testid={`signal-chip-${k}`}
            aria-pressed={on}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
}

function NullableSelect({ value, onChange, options, placeholder, testId }) {
  return (
    <Select
      value={value || "__none__"}
      onValueChange={(v) => onChange(v === "__none__" ? null : v)}
    >
      <SelectTrigger className="h-8 text-xs" data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">— any —</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="font-mono text-xs">
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PositionsEditor({ slotId }) {
  const queryClient = useQueryClient();
  const positionsQuery = useQuery({
    queryKey: ["slot_position_prefs", slotId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingSlotPositionPreference.filter(
        { slot_id: slotId },
        "position_index",
        100,
      );
      return Array.isArray(rows) ? rows : [];
    },
    enabled: Boolean(slotId),
  });

  const [draftPositions, setDraftPositions] = useState(null);
  const fetched = positionsQuery.data;
  // Seed draftPositions on first fetch.
  if (draftPositions === null && Array.isArray(fetched)) {
    const sorted = [...fetched].sort(
      (a, b) => (a.position_index ?? 0) - (b.position_index ?? 0),
    );
    setTimeout(() => setDraftPositions(sorted.map((r) => ({ ...r }))), 0);
  }

  const positions = Array.isArray(draftPositions) ? draftPositions : (fetched || []);

  const updatePos = (index, patch) => {
    setDraftPositions((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      if (!arr[index]) return arr;
      arr[index] = { ...arr[index], ...patch };
      return arr;
    });
  };

  const addPosition = () => {
    setDraftPositions((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      arr.push(emptyPosition(arr.length + 1));
      return arr;
    });
  };

  const removePosition = (index) => {
    setDraftPositions((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      const next = arr.filter((_, i) => i !== index);
      return next.map((p, i) => ({ ...p, position_index: i + 1 }));
    });
  };

  const onDragEnd = (result) => {
    if (!result.destination) return;
    setDraftPositions((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      const [moved] = arr.splice(result.source.index, 1);
      arr.splice(result.destination.index, 0, moved);
      return arr.map((p, i) => ({ ...p, position_index: i + 1 }));
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const arr = Array.isArray(draftPositions) ? draftPositions : [];
      const persisted = await api.entities.ShortlistingSlotPositionPreference.filter(
        { slot_id: slotId },
        "position_index",
        100,
      );
      const draftIds = new Set(arr.map((r) => r.id).filter(Boolean));
      const toDelete = (Array.isArray(persisted) ? persisted : []).filter(
        (r) => r.id && !draftIds.has(r.id),
      );
      for (const r of toDelete) {
        await api.entities.ShortlistingSlotPositionPreference.delete(r.id);
      }
      const results = [];
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        const payload = {
          slot_id: slotId,
          position_index: i + 1,
          display_label: (p.display_label || "").trim() || `Position ${i + 1}`,
          preferred_composition_type: p.preferred_composition_type || null,
          preferred_zone_focus: p.preferred_zone_focus || null,
          preferred_space_type: p.preferred_space_type || null,
          preferred_lighting_state: p.preferred_lighting_state || null,
          preferred_image_type: p.preferred_image_type || null,
          preferred_signal_emphasis: Array.isArray(p.preferred_signal_emphasis)
            ? p.preferred_signal_emphasis
            : [],
          is_required: Boolean(p.is_required),
          ai_backfill_on_gap: p.ai_backfill_on_gap !== false,
        };
        if (p.id) {
          results.push(
            await api.entities.ShortlistingSlotPositionPreference.update(
              p.id,
              payload,
            ),
          );
        } else {
          results.push(
            await api.entities.ShortlistingSlotPositionPreference.create(
              payload,
            ),
          );
        }
      }
      return results;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["slot_position_prefs", slotId],
      });
      toast.success("Positions saved.");
      setDraftPositions(null);
    },
    onError: (err) =>
      toast.error(`Save positions failed: ${err.message}`),
  });

  if (positionsQuery.isLoading) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 mr-1 inline animate-spin" />
        Loading positions…
      </div>
    );
  }

  return (
    <div
      className="space-y-2"
      data-testid={`positions-editor-${slotId}`}
      data-positions-count={positions.length}
    >
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId={`positions-${slotId}`}>
          {(provided) => (
            <div
              {...provided.droppableProps}
              ref={provided.innerRef}
              className="space-y-2"
            >
              {positions.length === 0 && (
                <div className="text-[11px] italic text-muted-foreground py-2">
                  No positions yet. Click &ldquo;+ Add position&rdquo; below to start.
                </div>
              )}
              {positions.map((pos, index) => (
                <Draggable
                  key={pos.id || `_new_${index}`}
                  draggableId={`pos-${slotId}-${pos.id || `_new_${index}`}`}
                  index={index}
                >
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      data-testid={`position-row-${index + 1}`}
                      data-position-index={index + 1}
                      className={cn(
                        "border rounded-md p-2 bg-card space-y-2 text-xs",
                        snapshot.isDragging && "shadow-lg opacity-80",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          {...provided.dragHandleProps}
                          className="cursor-grab active:cursor-grabbing text-muted-foreground"
                          aria-label={`Drag to reorder position ${index + 1}`}
                        >
                          <GripVertical className="h-4 w-4" />
                        </div>
                        <Badge variant="outline" className="text-[10px] tabular-nums">
                          Position {index + 1}
                        </Badge>
                        <Input
                          value={pos.display_label || ""}
                          onChange={(e) =>
                            updatePos(index, { display_label: e.target.value })
                          }
                          placeholder="Display label (e.g. Primary Hero)"
                          className="h-7 text-xs flex-1"
                          data-testid={`position-label-${index + 1}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                          onClick={() => removePosition(index)}
                          aria-label={`Remove position ${index + 1}`}
                          data-testid={`position-remove-${index + 1}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            Composition type
                          </Label>
                          <NullableSelect
                            value={pos.preferred_composition_type}
                            onChange={(v) =>
                              updatePos(index, { preferred_composition_type: v })
                            }
                            options={COMPOSITION_TYPE_OPTIONS}
                            placeholder="any composition"
                            testId={`position-composition-${index + 1}`}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            Zone focus
                          </Label>
                          <NullableSelect
                            value={pos.preferred_zone_focus}
                            onChange={(v) =>
                              updatePos(index, { preferred_zone_focus: v })
                            }
                            options={ZONE_FOCUS_OPTIONS}
                            placeholder="any zone"
                            testId={`position-zone-${index + 1}`}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            Space type
                          </Label>
                          <NullableSelect
                            value={pos.preferred_space_type}
                            onChange={(v) =>
                              updatePos(index, { preferred_space_type: v })
                            }
                            options={SPACE_TYPE_OPTIONS}
                            placeholder="any space"
                            testId={`position-space-${index + 1}`}
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            Lighting state
                          </Label>
                          <NullableSelect
                            value={pos.preferred_lighting_state}
                            onChange={(v) =>
                              updatePos(index, { preferred_lighting_state: v })
                            }
                            options={LIGHTING_STATE_OPTIONS}
                            placeholder="any lighting"
                            testId={`position-lighting-${index + 1}`}
                          />
                        </div>
                        <div className="col-span-2">
                          <Label className="text-[10px] text-muted-foreground">
                            Image type
                          </Label>
                          <NullableSelect
                            value={pos.preferred_image_type}
                            onChange={(v) =>
                              updatePos(index, { preferred_image_type: v })
                            }
                            options={IMAGE_TYPE_OPTIONS}
                            placeholder="any image type"
                            testId={`position-image-type-${index + 1}`}
                          />
                        </div>
                      </div>

                      <div>
                        <Label className="text-[10px] text-muted-foreground mb-1 block">
                          Preferred signal emphasis ({(pos.preferred_signal_emphasis || []).length}/{UNIVERSAL_SIGNAL_KEYS.length})
                        </Label>
                        <ChipSignalMultiselect
                          value={pos.preferred_signal_emphasis}
                          onChange={(v) =>
                            updatePos(index, { preferred_signal_emphasis: v })
                          }
                        />
                      </div>

                      <div className="flex items-center gap-4 pt-1">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <Checkbox
                            checked={Boolean(pos.is_required)}
                            onCheckedChange={(v) =>
                              updatePos(index, { is_required: v === true })
                            }
                            data-testid={`position-required-${index + 1}`}
                          />
                          <span className="text-[11px]">Required</span>
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <Checkbox
                            checked={pos.ai_backfill_on_gap !== false}
                            onCheckedChange={(v) =>
                              updatePos(index, { ai_backfill_on_gap: v === true })
                            }
                            data-testid={`position-backfill-${index + 1}`}
                          />
                          <span className="text-[11px]">AI backfill on gap</span>
                        </label>
                      </div>
                    </div>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>

      <div className="flex items-center justify-between pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={addPosition}
          data-testid={`position-add-${slotId}`}
        >
          <Plus className="h-3 w-3 mr-1" /> Add position
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          data-testid={`positions-save-${slotId}`}
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Saving…
            </>
          ) : (
            <>
              <Save className="h-3 w-3 mr-1" /> Save positions
            </>
          )}
        </Button>
      </div>
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
  // W11.6.7 P1-5: list of (id, slot_id, display_name) for the
  // same_room_as_slot picker. Excludes the current slot being edited.
  otherActiveSlots,
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
            <Label className="text-xs">Eligible when engine roles</Label>
            <EngineRoleMultiselect
              value={form.eligible_when_engine_roles}
              onChange={(v) => update("eligible_when_engine_roles", v)}
            />
            <p className="text-[10px] text-muted-foreground">
              Pick the engine roles that should trigger this slot. The slot is included for a
              round when ANY selected role overlaps the project's products' engine roles. At
              least one role is required — empty selections leave the slot unreachable.
            </p>
            {errors.eligible_when_engine_roles && (
              <p className="text-[10px] text-red-600">
                {errors.eligible_when_engine_roles}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Eligible room types <span className="text-muted-foreground">(legacy)</span></Label>
            <ChipMultiselect
              value={form.eligible_room_types}
              onChange={(v) => update("eligible_room_types", v)}
              options={ROOM_TYPE_SUGGESTIONS}
              placeholder="e.g. kitchen_main"
            />
            <p className="text-[10px] text-muted-foreground">
              Legacy compatibility field. The resolver falls back to this when both
              of the new SPACE/ZONE arrays below are empty.
            </p>
            {errors.eligible_room_types && (
              <p className="text-[10px] text-red-600">
                {errors.eligible_room_types}
              </p>
            )}
          </div>

          {/* W11.6.13 — orthogonal SPACE/ZONE eligibility arrays. */}
          <div className="space-y-1.5">
            <Label className="text-xs">Eligible space types <span className="text-muted-foreground">(architectural enclosure)</span></Label>
            <ChipMultiselect
              value={form.eligible_space_types}
              onChange={(v) => update("eligible_space_types", v)}
              options={SPACE_TYPE_SUGGESTIONS}
              placeholder="e.g. entry_foyer"
            />
            <p className="text-[10px] text-muted-foreground">
              W11.6.13: which architectural enclosures (4 walls) this slot accepts.
              Combined with eligible zone focuses below: if BOTH are populated, the
              resolver applies AND-intersection (image must match both axes). If
              only this is set, space-only matching. If neither is set, falls back
              to legacy room types above.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Eligible zone focuses <span className="text-muted-foreground">(compositional subject)</span></Label>
            <ChipMultiselect
              value={form.eligible_zone_focuses}
              onChange={(v) => update("eligible_zone_focuses", v)}
              options={ZONE_FOCUS_SUGGESTIONS}
              placeholder="e.g. door_threshold"
            />
            <p className="text-[10px] text-muted-foreground">
              W11.6.13: what the photographer is actually showing in the frame. For
              an entry hero use [door_threshold, full_facade] so a corner shot
              showing the facade gets a clean preference signal.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Lens class constraint (optional)</Label>
            <Select
              value={form.lens_class_constraint || "__any__"}
              onValueChange={(v) =>
                update("lens_class_constraint", v === "__any__" ? null : v)
              }
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Any (no constraint)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">Any (no constraint)</SelectItem>
                {LENS_CLASS_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              W11.6.7 P1-4: Stage 4 rejects winners whose <code className="font-mono">lens_class</code> doesn't match. Leave on &ldquo;Any&rdquo; for no constraint.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Eligible composition types (optional)</Label>
            <ChipMultiselect
              value={form.eligible_composition_types}
              onChange={(v) => update("eligible_composition_types", v)}
              options={COMPOSITION_TYPE_SUGGESTIONS}
              placeholder="e.g. hero_wide"
            />
            <p className="text-[10px] text-muted-foreground">
              W11.6.7 P1-5: when set, Stage 4 rejects winners whose <code className="font-mono">composition_type</code> isn't in the list. Empty = any.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Same room as slot (optional)</Label>
            <Select
              value={form.same_room_as_slot || "__none__"}
              onValueChange={(v) =>
                update("same_room_as_slot", v === "__none__" ? null : v)
              }
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="None — independent of other slots" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None — independent</SelectItem>
                {(otherActiveSlots || []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.slot_id} — {s.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              W11.6.7 P1-5: when set, Stage 4 enforces that THIS slot's winner has the same physical <code className="font-mono">room_type</code> as the linked anchor slot's winner (e.g. <code className="font-mono">bathroom_detail</code> must match the room of <code className="font-mono">bathroom_main</code>).
            </p>
          </div>

          {/* W11.6.22 — Selection mode toggle + curated positions editor. */}
          <div className="space-y-1.5 border-t pt-3">
            <Label className="text-xs font-medium">Selection mode (W11.6.22)</Label>
            <div
              role="radiogroup"
              aria-label="Selection mode"
              className="flex flex-col gap-2"
              data-testid="selection-mode-radio"
            >
              <label className="flex items-start gap-2 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="selection_mode"
                  value="ai_decides"
                  checked={form.selection_mode !== "curated_positions"}
                  onChange={() => update("selection_mode", "ai_decides")}
                  data-testid="mode-ai-decides"
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">AI decides</span>
                  <span className="block text-muted-foreground text-[11px]">
                    AI picks N images subject to existing eligibility (legacy default).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="selection_mode"
                  value="curated_positions"
                  checked={form.selection_mode === "curated_positions"}
                  onChange={() => update("selection_mode", "curated_positions")}
                  data-testid="mode-curated"
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Curated positions</span>
                  <span className="block text-muted-foreground text-[11px]">
                    Spec each position (composition / zone / space / lighting / image type / signal emphasis). AI picks one image per position; falls back per ai_backfill_on_gap.
                  </span>
                </span>
              </label>
            </div>
            {!isNew && form.selection_mode === "curated_positions" && (
              <div
                className="mt-3 border rounded-md p-3 bg-muted/30"
                data-testid="curated-positions-section"
              >
                <div className="flex items-baseline justify-between mb-2">
                  <p className="text-[11px] font-medium">Curated positions</p>
                  <p className="text-[10px] text-muted-foreground">
                    Position changes save independently of the slot version.
                  </p>
                </div>
                <PositionsEditor slotId={form.slot_id} />
              </div>
            )}
            {isNew && form.selection_mode === "curated_positions" && (
              <p className="text-[11px] italic text-muted-foreground">
                Save the slot first, then re-open the editor to add positions.
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
  // W11.6.5: package filter retired — slot eligibility is now an
  // engine-role concern, not a package-name concern. Phase + active-only
  // are the only relevant filters.
  const [phaseFilter, setPhaseFilter] = useState("all");
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
      return true;
    });
  }, [activeRows, allRows, phaseFilter, activeOnly]);

  // ── Save mutation: insert new + deactivate old (atomic-ish) ─────────────
  // W11.6.5: `package_types` removed from the write payload — the column was
  // dropped in mig 339 and validation now requires a non-empty
  // `eligible_when_engine_roles` array.
  const saveMutation = useMutation({
    mutationFn: async ({ form, isNew, currentRow }) => {
      if (isNew) {
        return await api.entities.ShortlistingSlotDefinition.create({
          slot_id: form.slot_id,
          display_name: form.display_name.trim(),
          phase: Number(form.phase),
          eligible_when_engine_roles: Array.isArray(form.eligible_when_engine_roles)
            ? form.eligible_when_engine_roles
            : [],
          eligible_room_types: form.eligible_room_types,
          // W11.6.13 — orthogonal SPACE/ZONE eligibility arrays.
          eligible_space_types: Array.isArray(form.eligible_space_types)
            ? form.eligible_space_types : [],
          eligible_zone_focuses: Array.isArray(form.eligible_zone_focuses)
            ? form.eligible_zone_focuses : [],
          max_images: Number(form.max_images),
          min_images: Number(form.min_images),
          // W11.6.7 P1-4 / P1-5: new constraint fields.
          lens_class_constraint: form.lens_class_constraint || null,
          eligible_composition_types: Array.isArray(form.eligible_composition_types) && form.eligible_composition_types.length > 0
            ? form.eligible_composition_types
            : null,
          same_room_as_slot: form.same_room_as_slot || null,
          // W11.6.22b: persist selection_mode (defaults to ai_decides).
          selection_mode: form.selection_mode === "curated_positions"
            ? "curated_positions"
            : "ai_decides",
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
        eligible_when_engine_roles: Array.isArray(form.eligible_when_engine_roles)
          ? form.eligible_when_engine_roles
          : [],
        eligible_room_types: form.eligible_room_types,
        // W11.6.13 — orthogonal SPACE/ZONE eligibility arrays.
        eligible_space_types: Array.isArray(form.eligible_space_types)
          ? form.eligible_space_types : [],
        eligible_zone_focuses: Array.isArray(form.eligible_zone_focuses)
          ? form.eligible_zone_focuses : [],
        max_images: Number(form.max_images),
        min_images: Number(form.min_images),
        // W11.6.7 P1-4 / P1-5: new constraint fields.
        lens_class_constraint: form.lens_class_constraint || null,
        eligible_composition_types: Array.isArray(form.eligible_composition_types) && form.eligible_composition_types.length > 0
          ? form.eligible_composition_types
          : null,
        same_room_as_slot: form.same_room_as_slot || null,
        // W11.6.22b: preserve admin's mode choice across versions.
        selection_mode: form.selection_mode === "curated_positions"
          ? "curated_positions"
          : "ai_decides",
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
          eligible_when_engine_roles: Array.isArray(row.eligible_when_engine_roles)
            ? [...row.eligible_when_engine_roles]
            : [],
          eligible_room_types: Array.isArray(row.eligible_room_types)
            ? [...row.eligible_room_types]
            : [],
          // W11.6.13 — orthogonal SPACE/ZONE eligibility arrays.
          eligible_space_types: Array.isArray(row.eligible_space_types)
            ? [...row.eligible_space_types] : [],
          eligible_zone_focuses: Array.isArray(row.eligible_zone_focuses)
            ? [...row.eligible_zone_focuses] : [],
          max_images: row.max_images ?? 1,
          min_images: row.min_images ?? 0,
          lens_class_constraint: row.lens_class_constraint ?? null,
          eligible_composition_types: Array.isArray(row.eligible_composition_types)
            ? [...row.eligible_composition_types]
            : [],
          same_room_as_slot: row.same_room_as_slot ?? null,
          // W11.6.22b: seed mode from the row, fall back to ai_decides for any
          // legacy cached rows pre-dating mig 417.
          selection_mode: row.selection_mode === "curated_positions"
            ? "curated_positions"
            : "ai_decides",
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
                      <th className="px-3 py-2 font-medium">Mode</th>
                      <th className="px-3 py-2 font-medium">Engine roles</th>
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
                      const engineRoles = Array.isArray(row.eligible_when_engine_roles)
                        ? row.eligible_when_engine_roles
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
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                row.selection_mode === "curated_positions"
                                  ? "border-amber-300 text-amber-700 dark:text-amber-300"
                                  : "border-border text-muted-foreground",
                              )}
                              data-testid={`mode-badge-${row.slot_id}`}
                              data-selection-mode={row.selection_mode || "ai_decides"}
                            >
                              {row.selection_mode === "curated_positions"
                                ? "Curated"
                                : "AI decides"}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 max-w-[220px]">
                            {engineRoles.length === 0 ? (
                              <span className="text-[10px] text-muted-foreground italic">
                                (misconfigured — engine roles required)
                              </span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {engineRoles.map((r) => (
                                  <Badge
                                    key={r}
                                    variant="outline"
                                    className="text-[9px] font-mono"
                                  >
                                    {r}
                                  </Badge>
                                ))}
                              </div>
                            )}
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
            otherActiveSlots={activeRows
              .filter((r) => r.slot_id !== editorState.editingSlotId)
              .map((r) => ({ id: r.id, slot_id: r.slot_id, display_name: r.display_name }))}
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

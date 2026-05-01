/**
 * ReclassifyDialog — Wave 11.6.9 (W11.5 frontend leg)
 *
 * Inline single-field editor opened from inside the ShortlistingCard "Why?"
 * expander. Each correctable field renders a tiny pencil button next to its
 * current value; clicking the pencil mounts THIS dialog with the appropriate
 * widget, submitting back to the shortlisting-overrides edge fn's `reclassify`
 * action.
 *
 * Spec: docs/design-specs/W11-5-human-reclassification-capture.md §"Section 3"
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "lucide-react";

// Canonical taxonomies — MUST stay in lockstep with:
//   - supabase/functions/_shared/visionPrompts/blocks/roomTypeTaxonomy.ts
//   - supabase/functions/_shared/visionPrompts/blocks/compositionTypeTaxonomy.ts
//   - supabase/functions/_shared/visionPrompts/blocks/vantagePoint.ts
//   - supabase/functions/_shared/visionPrompts/blocks/slotEnumeration.ts
//   - supabase/functions/_shared/reclassifyValidate.ts (CANONICAL_*)
// Duplicated rather than imported — supabase/ → flexmedia-src/ would cross
// the module boundary. The validator is the authoritative gate; this list is
// for UX (build the dropdown). Drift here = option missing from dropdown,
// not bad data.
const ROOM_TYPES = [
  { value: "interior_open_plan", label: "Interior open plan" },
  { value: "kitchen_main", label: "Kitchen (main)" },
  { value: "kitchen_scullery", label: "Kitchen (scullery)" },
  { value: "living_room", label: "Living room" },
  { value: "living_secondary", label: "Living (secondary)" },
  { value: "dining_room", label: "Dining room" },
  { value: "master_bedroom", label: "Master bedroom" },
  { value: "bedroom_secondary", label: "Bedroom (secondary)" },
  { value: "ensuite_primary", label: "Ensuite (primary)" },
  { value: "ensuite_secondary", label: "Ensuite (secondary)" },
  { value: "bathroom", label: "Bathroom" },
  { value: "wir_wardrobe", label: "Walk-in robe / wardrobe" },
  { value: "study_office", label: "Study / office" },
  { value: "laundry", label: "Laundry" },
  { value: "entry_foyer", label: "Entry / foyer" },
  { value: "staircase", label: "Staircase" },
  { value: "hallway_corridor", label: "Hallway / corridor" },
  { value: "home_cinema", label: "Home cinema" },
  { value: "games_room", label: "Games room" },
  { value: "gymnasium", label: "Gym" },
  { value: "wine_cellar", label: "Wine cellar" },
  { value: "garage_showcase", label: "Garage (showcase)" },
  { value: "garage_standard", label: "Garage (standard)" },
  { value: "alfresco", label: "Alfresco" },
  { value: "pool_area", label: "Pool area" },
  { value: "outdoor_kitchen", label: "Outdoor kitchen" },
  { value: "courtyard_internal", label: "Courtyard (internal)" },
  { value: "balcony_terrace", label: "Balcony / terrace" },
  { value: "exterior_front", label: "Exterior — front" },
  { value: "exterior_rear", label: "Exterior — rear" },
  { value: "exterior_side", label: "Exterior — side" },
  { value: "exterior_detail", label: "Exterior detail" },
  { value: "drone_contextual", label: "Drone (contextual)" },
  { value: "drone_nadir", label: "Drone (nadir)" },
  { value: "drone_oblique", label: "Drone (oblique)" },
  { value: "floorplan", label: "Floorplan" },
  { value: "detail_material", label: "Material detail" },
  { value: "detail_lighting", label: "Lighting detail" },
  { value: "lifestyle_vehicle", label: "Lifestyle / vehicle" },
  { value: "special_feature", label: "Special feature" },
];

const COMPOSITION_TYPES = [
  { value: "hero_wide", label: "Hero wide" },
  { value: "corner_two_point", label: "Corner / two-point" },
  { value: "detail_closeup", label: "Detail / close-up" },
  { value: "corridor_leading", label: "Corridor leading" },
  { value: "straight_on", label: "Straight on" },
  { value: "overhead", label: "Overhead" },
  { value: "upward_void", label: "Upward void" },
  { value: "threshold_transition", label: "Threshold transition" },
  { value: "drone_nadir", label: "Drone nadir" },
  { value: "drone_oblique_contextual", label: "Drone oblique" },
  { value: "architectural_abstract", label: "Architectural abstract" },
];

const VANTAGE_POINTS = [
  { value: "interior_looking_out", label: "Interior looking out" },
  { value: "exterior_looking_in", label: "Exterior looking in" },
  { value: "neutral", label: "Neutral" },
];

const SLOT_OPTIONS = [
  { value: "exterior_facade_hero", label: "Exterior facade (hero)", phase: 1 },
  { value: "kitchen_hero", label: "Kitchen (hero)", phase: 1 },
  { value: "living_hero", label: "Living (hero)", phase: 1 },
  { value: "master_bedroom_hero", label: "Master bedroom (hero)", phase: 1 },
  { value: "alfresco_hero", label: "Alfresco (hero)", phase: 1 },
  { value: "exterior_rear", label: "Exterior — rear", phase: 2 },
  { value: "kitchen_secondary", label: "Kitchen (secondary)", phase: 2 },
  { value: "dining_hero", label: "Dining (hero)", phase: 2 },
  { value: "bedroom_secondary", label: "Bedroom (secondary)", phase: 2 },
  { value: "bathroom_main", label: "Bathroom (main)", phase: 2 },
  { value: "ensuite_hero", label: "Ensuite (hero)", phase: 2 },
  { value: "entry_hero", label: "Entry (hero)", phase: 2 },
  { value: "study_hero", label: "Study (hero)", phase: 2 },
  { value: "powder_room", label: "Powder room", phase: 2 },
  { value: "laundry_hero", label: "Laundry (hero)", phase: 2 },
  { value: "garage_hero", label: "Garage (hero)", phase: 2 },
  { value: "pool_hero", label: "Pool (hero)", phase: 2 },
  { value: "view_hero", label: "View (hero)", phase: 2 },
  { value: "kitchen_detail", label: "Kitchen detail", phase: 3 },
  { value: "bathroom_detail", label: "Bathroom detail", phase: 3 },
  { value: "material_detail", label: "Material detail", phase: 3 },
  { value: "garden_detail", label: "Garden detail", phase: 3 },
  { value: "balcony_terrace", label: "Balcony / terrace", phase: 3 },
  { value: "games_room", label: "Games room", phase: 3 },
  { value: "media_room", label: "Media room", phase: 3 },
];

const FIELD_META = {
  room_type: {
    title: "Reclassify room type",
    desc: "Override the engine's room_type. Stored in project_memory and applied to subsequent Stage 1 runs on this property.",
  },
  composition_type: {
    title: "Reclassify composition type",
    desc: "Override the engine's composition_type judgement.",
  },
  vantage_point: {
    title: "Reclassify vantage point",
    desc: "Override the engine's vantage_point. Critical for alfresco / exterior_rear disambiguation.",
  },
  combined_score: {
    title: "Adjust combined score",
    desc: "Manually set the combined score (0-10, 0.5 step). Master-admin scores are flagged authoritative.",
  },
  eligible_slot_ids: {
    title: "Adjust slot eligibility",
    desc: "Override which slots this composition is eligible for.",
  },
};

const SCORE_MIN = 0;
const SCORE_MAX = 10;
const SCORE_STEP = 0.5;

export default function ReclassifyDialog({
  open,
  onOpenChange,
  field,
  aiValue,
  currentValue,
  onSubmit,
}) {
  const [value, setValue] = useState(currentValue);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setValue(currentValue ?? defaultValueFor(field));
      setReason("");
      setError(null);
    }
  }, [open, field, currentValue]);

  if (!field || !FIELD_META[field]) return null;
  const meta = FIELD_META[field];

  const handleSubmit = async () => {
    setError(null);
    const validated = preValidate(field, value);
    if (!validated.ok) {
      setError(validated.message);
      return;
    }
    if (deepEquals(validated.value, currentValue)) {
      setError("Value is unchanged. Pick a different value or close the dialog.");
      return;
    }
    setSubmitting(true);
    try {
      const trimmedReason = reason.trim();
      await onSubmit({
        field,
        humanValue: validated.value,
        aiValue,
        overrideReason: trimmedReason.length > 0 ? trimmedReason : null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err?.message || "Save failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (submitting ? null : onOpenChange(o))}>
      <DialogContent
        className="sm:max-w-md"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{meta.title}</DialogTitle>
          <DialogDescription className="text-xs">{meta.desc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">AI value:</span>{" "}
            <span className="font-mono">{formatDisplay(field, aiValue)}</span>
          </div>

          {field === "room_type" && (
            <FieldSelect value={value} onChange={setValue} options={ROOM_TYPES} placeholder="Select room type" disabled={submitting} />
          )}
          {field === "composition_type" && (
            <FieldSelect value={value} onChange={setValue} options={COMPOSITION_TYPES} placeholder="Select composition type" disabled={submitting} />
          )}
          {field === "vantage_point" && (
            <FieldSelect value={value} onChange={setValue} options={VANTAGE_POINTS} placeholder="Select vantage point" disabled={submitting} />
          )}
          {field === "combined_score" && (
            <div className="space-y-1">
              <Label htmlFor="reclassify-score" className="text-xs">Score (0-10, 0.5 step)</Label>
              <Input
                id="reclassify-score"
                type="number"
                min={SCORE_MIN}
                max={SCORE_MAX}
                step={SCORE_STEP}
                value={value ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  setValue(raw === "" ? null : Number(raw));
                }}
                disabled={submitting}
              />
            </div>
          )}
          {field === "eligible_slot_ids" && (
            <SlotMultiSelect value={Array.isArray(value) ? value : []} onChange={setValue} disabled={submitting} />
          )}

          <div className="space-y-1">
            <Label htmlFor="reclassify-reason" className="text-xs">Reason (optional)</Label>
            <Textarea
              id="reclassify-reason"
              placeholder="e.g. Hills Hoist clearly visible — back yard, not front."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
              rows={2}
              disabled={submitting}
              className="text-xs resize-none"
            />
            <div className="text-[10px] text-muted-foreground text-right">{reason.length}/2000</div>
          </div>

          {error && (
            <div className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded px-2 py-1">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Save override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldSelect({ value, onChange, options, placeholder, disabled }) {
  const safeValue = value ?? undefined;
  return (
    <Select value={safeValue} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SlotMultiSelect({ value, onChange, disabled }) {
  const phases = [1, 2, 3];
  const toggle = (slotId) => {
    if (disabled) return;
    if (value.includes(slotId)) onChange(value.filter((s) => s !== slotId));
    else onChange([...value, slotId]);
  };
  return (
    <div className="space-y-2 max-h-64 overflow-y-auto border rounded-md p-2">
      {phases.map((p) => (
        <div key={p} className="space-y-1">
          <div className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">Phase {p}</div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            {SLOT_OPTIONS.filter((s) => s.phase === p).map((opt) => (
              <label key={opt.value} className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5">
                <Checkbox checked={value.includes(opt.value)} onCheckedChange={() => toggle(opt.value)} disabled={disabled} />
                <span className="truncate">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function preValidate(field, value) {
  if (field === "room_type" || field === "composition_type" || field === "vantage_point") {
    if (typeof value !== "string" || value.length === 0) return { ok: false, message: "Please select a value." };
    return { ok: true, value };
  }
  if (field === "combined_score") {
    if (value === null || value === undefined || value === "") return { ok: false, message: "Please enter a score." };
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, message: "Score must be a number." };
    if (n < SCORE_MIN || n > SCORE_MAX) return { ok: false, message: `Score must be between ${SCORE_MIN} and ${SCORE_MAX}.` };
    return { ok: true, value: Math.round(n * 2) / 2 };
  }
  if (field === "eligible_slot_ids") {
    if (!Array.isArray(value)) return { ok: false, message: "Slot IDs must be an array." };
    if (value.length === 0) return { ok: false, message: "Pick at least one slot." };
    if (value.length > 10) return { ok: false, message: "At most 10 slots." };
    return { ok: true, value };
  }
  return { ok: false, message: `Unknown field: ${field}` };
}

function defaultValueFor(field) {
  if (field === "combined_score") return null;
  if (field === "eligible_slot_ids") return [];
  return "";
}

function formatDisplay(field, value) {
  if (value == null) return "—";
  if (field === "eligible_slot_ids") {
    if (!Array.isArray(value) || value.length === 0) return "—";
    return value.join(", ");
  }
  if (field === "combined_score") return Number(value).toFixed(1);
  return String(value);
}

function deepEquals(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return false;
}

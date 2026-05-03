/**
 * PositionRow — single position list-item with expandable editor.
 *
 * Collapsed: shows the position index, room (friendly label), phase, and a
 * one-line constraint summary. Click ▶ to expand into the full constraint
 * editor.
 *
 * Expanded layout (W11.6.29 / mig 451 — Position Editor restructure):
 *
 *   Top strip — phase / selection_mode / ai_backfill_on_gap
 *
 *   Default-visible constraints (5):
 *     • Room              — friendly labels backed by space_type
 *     • Zone focus        — friendly labels backed by zone_focus
 *     • Shot scale        — wide / medium / tight / detail / vignette
 *     • Perspective       — expanded / neutral / compressed
 *
 *   "More constraints" expander (collapsed by default; 5 axes + instance pair):
 *     • Vantage position       — eye_level / corner / through_doorway / aerial / …
 *     • Composition geometry   — 1-point / leading_lines / symmetrical / …
 *     • Image type             — is_day / is_dusk / is_drone / is_floorplan / …
 *     • Lens class             — ultrawide / wide / standard / telephoto
 *     • Orientation            — landscape / portrait / square
 *     • Instance               — Any / 1st / 2nd / 3rd / 4th detected (W11.8)
 *     • Force unique instance  — checkbox; spreads coverage across rooms (W11.8)
 *
 *   Notes (free-text)  — kept where it was.
 *
 *   Insert from template + Save / Reset / Delete actions.
 *
 * The legacy `room_type` and `composition_type` columns were dropped from
 * gallery_positions in mig 451; this editor never references them. The Room
 * dropdown is backed by `space_type` (operator-friendly: still a single
 * "which room" choice, but uses the orthogonal v2-schema axis).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRight,
  ChevronDown,
  Save,
  Trash2,
  RotateCcw,
  Star,
  SlidersHorizontal,
} from "lucide-react";
import { IconTip } from "./Tip";
import {
  CONSTRAINT_AXES,
  PHASES,
  SELECTION_MODES,
  CONSTRAINT_KEYS,
  pickConstraints,
  constraintCount,
  friendlyLabelForSpaceType,
  friendlyLabelGeneric,
  VANTAGE_POSITION_LABELS,
  COMPOSITION_GEOMETRY_LABELS,
} from "./constants";
import { useAxisDistribution } from "./hooks";

const ANY_VALUE = "__any__";

// Per-axis picker-side label resolvers. Returns a function (value) => string.
// Default fallback is friendlyLabelGeneric (snake_case → "Title case").
function labelFnForAxis(axis) {
  if (axis.key === "space_type") return friendlyLabelForSpaceType;
  if (axis.key === "vantage_position") {
    return (v) => VANTAGE_POSITION_LABELS[v] ?? friendlyLabelGeneric(v);
  }
  if (axis.key === "composition_geometry") {
    return (v) => COMPOSITION_GEOMETRY_LABELS[v] ?? friendlyLabelGeneric(v);
  }
  // shot_scale / perspective_compression / lens_class / orientation /
  // image_type / zone_focus all read cleanly via the generic snake_case
  // → Title case fallback.
  return friendlyLabelGeneric;
}

export default function PositionRow({
  position,
  index,
  templates = [],
  onSave,
  onDelete,
  saving,
}) {
  const [expanded, setExpanded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [draft, setDraft] = useState(() => normalisePosition(position));

  // When the upstream position changes (after save), refresh the draft.
  useEffect(() => {
    setDraft(normalisePosition(position));
  }, [position]);

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(normalisePosition(position)),
    [draft, position],
  );

  // Summary line on the collapsed row — show a friendly room label first,
  // then up to 2 other set constraints.
  //
  // W11.8 / mig 454: `instance_index` shows as e.g. "instance=1st detected"
  // when set; `instance_unique_constraint` shows as "unique instance" when
  // TRUE (false is the default, no-op behaviour, hidden from the summary).
  const summaryConstraints = useMemo(() => {
    const out = [];
    for (const axis of CONSTRAINT_AXES) {
      const v = draft[axis.key];
      if (axis.key === "instance_unique_constraint") {
        if (v === true) out.push("unique instance");
        continue;
      }
      if (axis.key === "instance_index") {
        if (v == null) continue;
        const opt = axis.options?.find((o) => o.value === v);
        out.push(`instance=${opt?.label ?? v}`);
        continue;
      }
      if (!v) continue;
      const labelFn = labelFnForAxis(axis);
      const display = labelFn(v);
      out.push(`${axis.label.toLowerCase()}=${display}`);
    }
    return out;
  }, [draft]);

  const headerLabel = useMemo(() => {
    if (draft.space_type) return friendlyLabelForSpaceType(draft.space_type);
    if (draft.image_type) return friendlyLabelGeneric(draft.image_type);
    return "—";
  }, [draft.space_type, draft.image_type]);

  const isOverridden = position?.is_overridden_at_cell;

  // Split the constraint axes into the two render groups. The
  // `instance` kind axes (W11.8 / mig 454) are rendered as bespoke
  // controls AFTER the regular ConstraintPicker grid so the layout
  // and "(any)" semantics stay consistent for the existing 5 axes.
  const defaultAxes = CONSTRAINT_AXES.filter((a) => a.group === "default");
  const moreAxes = CONSTRAINT_AXES.filter(
    (a) => a.group === "more" && a.kind !== "instance",
  );
  const instanceAxes = CONSTRAINT_AXES.filter(
    (a) => a.group === "more" && a.kind === "instance",
  );
  // moreSetCount counts every "more" axis that's actively constraining
  // selection. instance_unique_constraint = false is the default (no-op)
  // behaviour and doesn't count; instance_index = null is "Any" and
  // doesn't count either.
  const moreSetCount =
    moreAxes.reduce(
      (n, a) =>
        draft[a.key] != null && draft[a.key] !== "" ? n + 1 : n,
      0,
    ) +
    (draft.instance_index != null ? 1 : 0) +
    (draft.instance_unique_constraint === true ? 1 : 0);
  const allMoreAxesCount = moreAxes.length + instanceAxes.length;

  return (
    <div
      className="rounded-md border border-border bg-background"
      data-testid={`position-row-${index}`}
    >
      {/* Collapsed header */}
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          data-testid={`position-toggle-${index}`}
          aria-label={expanded ? "Collapse position" : "Expand position"}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <span className="text-xs font-mono text-muted-foreground">
          #{index + 1}
        </span>

        <span className="text-xs font-medium">{headerLabel}</span>

        <Badge variant="outline" className="text-[10px]">
          {draft.phase || "optional"}
        </Badge>

        {summaryConstraints.length > 0 && (
          <span className="text-[11px] text-muted-foreground truncate max-w-md">
            {summaryConstraints.slice(0, 3).join(", ")}
            {summaryConstraints.length > 3 && " …"}
          </span>
        )}

        {summaryConstraints.length === 0 && (
          <span className="text-[11px] text-muted-foreground italic">
            (rest = AI)
          </span>
        )}

        {isOverridden && (
          <IconTip
            text="This position is overridden at the cell level. The corresponding inherited row from a broader scope is replaced."
          >
            <Star className="h-3 w-3 text-amber-500 fill-amber-400" />
          </IconTip>
        )}

        <span className="text-[10px] text-muted-foreground ml-auto mr-2">
          {constraintCount(draft)} / {CONSTRAINT_AXES.length} constraints set
        </span>
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="p-3 border-t bg-muted/30 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-[11px] flex items-center gap-1">
                Phase
                <IconTip
                  text={
                    PHASES.find((p) => p.key === draft.phase)?.blurb ||
                    "How strictly the engine must fill this position."
                  }
                />
              </Label>
              <Select
                value={draft.phase || "optional"}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, phase: v }))
                }
              >
                <SelectTrigger className="h-7 text-xs" data-testid={`phase-select-${index}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHASES.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] flex items-center gap-1">
                Selection mode
                <IconTip
                  text={
                    SELECTION_MODES.find((s) => s.key === draft.selection_mode)?.blurb ||
                    "How the engine picks a winning image for this position."
                  }
                />
              </Label>
              <Select
                value={draft.selection_mode || "ai_decides"}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, selection_mode: v }))
                }
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELECTION_MODES.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end gap-2">
              <div className="flex flex-col">
                <Label className="text-[11px] flex items-center gap-1">
                  AI backfill on gap
                  <IconTip
                    text="When ON, if no image matches the constraints, the engine fills with the strongest uncommitted shot. When OFF, the position can stay empty."
                  />
                </Label>
                <Switch
                  checked={Boolean(draft.ai_backfill_on_gap)}
                  onCheckedChange={(v) =>
                    setDraft((d) => ({ ...d, ai_backfill_on_gap: v }))
                  }
                  data-testid={`ai-backfill-${index}`}
                />
              </div>
            </div>
          </div>

          {/* Default-visible constraints (5 axes) */}
          <div data-testid={`constraints-default-${index}`}>
            <div className="text-[11px] font-semibold flex items-center gap-1 mb-1.5">
              Constraints
              <IconTip
                text="Set what you care about; leave NULL ('Any') to let the engine pick. Use the Taxonomy Explorer subtab to see counts and samples for each value."
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {defaultAxes.map((axis) => (
                <ConstraintPicker
                  key={axis.key}
                  axis={axis}
                  value={draft[axis.key]}
                  onChange={(v) =>
                    setDraft((d) => ({ ...d, [axis.key]: v }))
                  }
                  testIdPrefix={`constraint-${index}`}
                />
              ))}
            </div>
          </div>

          {/* "More constraints" expander — collapsed by default */}
          <div className="rounded-md border border-dashed bg-background/40">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] hover:bg-muted/40 rounded-md"
              data-testid={`more-constraints-toggle-${index}`}
              data-open={moreOpen ? "true" : "false"}
              aria-expanded={moreOpen}
            >
              <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                {moreOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <SlidersHorizontal className="h-3 w-3" />
                More constraints
                <span className="text-[10px] font-normal opacity-80">
                  (vantage, geometry, image type, lens, orientation, instance)
                </span>
              </span>
              <span className="text-[10px] text-muted-foreground">
                {moreSetCount} / {allMoreAxesCount} set
              </span>
            </button>
            {moreOpen && (
              <div
                className="p-2.5 pt-0 space-y-2"
                data-testid={`constraints-more-${index}`}
              >
                <div className="grid grid-cols-2 gap-2">
                  {moreAxes.map((axis) => (
                    <ConstraintPicker
                      key={axis.key}
                      axis={axis}
                      value={draft[axis.key]}
                      onChange={(v) =>
                        setDraft((d) => ({ ...d, [axis.key]: v }))
                      }
                      testIdPrefix={`constraint-${index}`}
                    />
                  ))}
                </div>

                {/* W11.8 / mig 454: space-instance targeting controls. */}
                <div
                  className="grid grid-cols-2 gap-2 pt-1.5 border-t border-dashed"
                  data-testid={`constraints-more-instance-${index}`}
                >
                  <InstanceIndexPicker
                    axis={instanceAxes.find(
                      (a) => a.key === "instance_index",
                    )}
                    value={draft.instance_index}
                    onChange={(v) =>
                      setDraft((d) => ({ ...d, instance_index: v }))
                    }
                    testId={`constraint-${index}-instance_index`}
                  />
                  <InstanceUniqueCheckbox
                    axis={instanceAxes.find(
                      (a) => a.key === "instance_unique_constraint",
                    )}
                    value={draft.instance_unique_constraint}
                    onChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        instance_unique_constraint: v,
                      }))
                    }
                    testId={`constraint-${index}-instance_unique_constraint`}
                  />
                </div>
              </div>
            )}
          </div>

          <div>
            <Label className="text-[11px]">Notes</Label>
            <Textarea
              className="text-xs min-h-[48px]"
              placeholder="Optional free-text note (visible to operators only)."
              value={draft.notes ?? ""}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  // BUG-4 FIX (QC v2): empty notes become null, not "" — keeps
                  // round-trip parity with the DB and avoids spurious isDirty.
                  notes: e.target.value === "" ? null : e.target.value,
                }))
              }
              data-testid={`position-notes-${index}`}
            />
          </div>

          <div>
            <Label className="text-[11px] flex items-center gap-1">
              Insert from template
              <IconTip
                text="Pre-fills the constraint axes from a slot_definition. After insertion the position is independent — editing the template later does not rewrite this position."
              />
            </Label>
            <Select
              value=""
              onValueChange={(slotId) => {
                const t = templates.find((s) => s.slot_id === slotId);
                if (!t) return;
                setDraft((d) => ({
                  ...d,
                  template_slot_id: t.slot_id,
                  // Mig 451: legacy slot_definitions only carry
                  // eligible_room_types — map a single-entry list onto the
                  // friendly Room dropdown by setting space_type rather than
                  // the now-dropped room_type column. The label resolver
                  // handles unknown values gracefully so we don't lose any
                  // template that hasn't been re-keyed yet.
                  space_type:
                    Array.isArray(t.eligible_room_types) &&
                    t.eligible_room_types.length === 1
                      ? mapLegacyRoomTypeToSpaceType(t.eligible_room_types[0]) ??
                        d.space_type
                      : d.space_type,
                  phase:
                    t.phase === 1 ? "mandatory" : t.phase === 2 ? "conditional" : "optional",
                }));
              }}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="Pick a template…" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.slot_id} value={t.slot_id}>
                    {t.display_name} <span className="text-muted-foreground">({t.slot_id})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2 pt-2 border-t">
            <Button
              size="sm"
              onClick={() => onSave?.(draft)}
              disabled={!isDirty || saving}
              data-testid={`position-save-${index}`}
            >
              <Save className="h-3 w-3 mr-1.5" />
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(normalisePosition(position))}
              disabled={!isDirty}
              data-testid={`position-reset-${index}`}
            >
              <RotateCcw className="h-3 w-3 mr-1.5" />
              Reset
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete?.(position)}
              className="ml-auto text-rose-600 hover:text-rose-700"
              data-testid={`position-delete-${index}`}
            >
              <Trash2 className="h-3 w-3 mr-1.5" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Space-instance controls (W11.8 / mig 454) ──────────────────────────
//
// Bespoke renderers for the two `kind: 'instance'` axes. They live as
// columns of a Grid-2 row inside the More-constraints expander, beneath
// the standard ConstraintPicker grid.

function InstanceIndexPicker({ axis, value, onChange, testId }) {
  // Hardcoded options (1..4 + Any) — instance_index has a finite ceiling
  // by design (more than 4 dwellings of the same room type is rare; the
  // rest can be authored via raw JSON).
  const ANY = "__any__";
  const options = axis?.options ?? [];
  return (
    <div>
      <Label className="text-[11px] flex items-center gap-1">
        {axis?.label || "Instance"}
        <IconTip text={axis?.tooltip} />
      </Label>
      <Select
        value={value == null ? ANY : String(value)}
        onValueChange={(v) => onChange(v === ANY ? null : Number(v))}
      >
        <SelectTrigger className="h-7 text-xs" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem
              key={opt.value == null ? ANY : String(opt.value)}
              value={opt.value == null ? ANY : String(opt.value)}
            >
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function InstanceUniqueCheckbox({ axis, value, onChange, testId }) {
  const checked = value === true;
  return (
    <div className="flex flex-col">
      <Label className="text-[11px] flex items-center gap-1">
        {axis?.label || "Force unique instance"}
        <IconTip text={axis?.tooltip} />
      </Label>
      <div className="flex items-center gap-2 h-7">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          data-testid={testId}
        />
        <span className="text-[11px] text-muted-foreground">
          {checked
            ? "Spread across different physical rooms"
            : "Allow positions to share the same room"}
        </span>
      </div>
    </div>
  );
}

function ConstraintPicker({ axis, value, onChange, testIdPrefix }) {
  const { data = [], isLoading } = useAxisDistribution(axis.key);
  const items = data;
  const labelFn = labelFnForAxis(axis);

  return (
    <div>
      <Label className="text-[11px] flex items-center gap-1">
        {axis.label}
        <IconTip text={axis.tooltip} />
      </Label>
      <Select
        value={value || ANY_VALUE}
        onValueChange={(v) => onChange(v === ANY_VALUE ? null : v)}
      >
        <SelectTrigger
          className="h-7 text-xs"
          data-testid={`${testIdPrefix}-${axis.key}`}
        >
          <SelectValue placeholder={isLoading ? "loading…" : "(any)"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_VALUE}>(any) — engine picks</SelectItem>
          {items.map((row) => (
            <SelectItem key={row.value} value={row.value}>
              <span>{labelFn(row.value)}</span>
              {row.n_compositions != null && (
                <span className="text-[10px] text-muted-foreground ml-2">
                  {row.n_compositions}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── Legacy room_type → space_type mapping ────────────────────────────────
//
// Templates authored before mig 451 store an `eligible_room_types[]`
// array with the old vocabulary (kitchen_main / master_bedroom_focal /
// living_main / etc.). When an operator inserts such a template into a
// new position, we want the Room dropdown to land on the closest
// `space_type` value rather than leaving the field blank.
//
// Anything outside this map returns null and the editor leaves the Room
// unset — operators can pick from the friendly list manually. We don't
// log a warning because this is a soft migration path; templates will
// drift onto space_type over time and stale entries become harmless.
const LEGACY_ROOM_TYPE_TO_SPACE_TYPE = Object.freeze({
  kitchen_main: "kitchen_dedicated",
  kitchen_alt: "kitchen_dedicated",
  master_bedroom_focal: "master_bedroom",
  master_bedroom: "master_bedroom",
  bedroom_secondary: "bedroom_secondary",
  bedroom_focal: "bedroom_secondary",
  living_main: "living_room_dedicated",
  living_focal: "living_room_dedicated",
  dining_focal: "dining_room_dedicated",
  bathroom_main: "bathroom",
  ensuite_main: "ensuite",
  laundry_main: "laundry",
  exterior_front: "exterior_facade",
  exterior_back: "exterior_rear",
  pool_focal: "pool_area",
  garden_focal: "garden",
  streetscape: "streetscape",
});

function mapLegacyRoomTypeToSpaceType(legacyValue) {
  if (!legacyValue) return null;
  return LEGACY_ROOM_TYPE_TO_SPACE_TYPE[legacyValue] ?? null;
}

// Exported for unit testing (Bug 4 — notes nullability spurious-isDirty fix
// and the W11.6.29 / mig 451 restructure: no room_type / composition_type
// in the canonical draft shape).
export function normalisePosition(position) {
  const base = {
    id: position?.id || null,
    package_id: position?.package_id || null,
    price_tier_id: position?.price_tier_id || null,
    project_type_id: position?.project_type_id || null,
    product_id: position?.product_id || null,
    engine_role: position?.engine_role || "photo_day_shortlist",
    position_index: position?.position_index ?? null,
    phase: position?.phase || "optional",
    selection_mode: position?.selection_mode || "ai_decides",
    ai_backfill_on_gap: position?.ai_backfill_on_gap ?? true,
    template_slot_id: position?.template_slot_id || null,
    // BUG-4 FIX (QC v2 — 2026-05-02): keep `notes` strictly null when
    // unset. Earlier code coerced to "" which made every freshly loaded row
    // appear "dirty" against the DB-backed null after JSON.stringify diff
    // (`{notes:null}` vs `{notes:""}` are not equal). Use `?? null` so
    // empty strings ALSO normalise to null.
    notes: position?.notes ?? null,
    ...pickConstraints(position),
  };
  // Ensure every constraint axis is present (even if NULL).
  for (const k of CONSTRAINT_KEYS) {
    if (!(k in base)) base[k] = null;
  }
  // W11.8 / mig 454: `instance_unique_constraint` defaults to FALSE rather
  // than NULL — the DB column is NOT NULL with default false, so missing
  // inputs must canonicalise to false (not the wildcard null) for the
  // dirty-check + save round-trip to stay in parity. pickConstraints
  // already enforces this; we override the loop's null assignment here in
  // case a draft slipped through with the field absent.
  if (
    base.instance_unique_constraint == null ||
    base.instance_unique_constraint === ""
  ) {
    base.instance_unique_constraint = false;
  }
  return base;
}

/**
 * PositionRow — single position list-item with expandable editor.
 *
 * Collapsed: shows the position index, room/space, phase, and a
 * one-line constraint summary. Click ▶ to expand into the full
 * constraint editor.
 *
 * Expanded: every constraint axis appears as a Select with values
 * pulled live from `taxonomy_b_axis_distribution(axis)` (or the
 * shot_scale / compression / lens_class finite vocabs). An "(any)"
 * option always sits at the top — picking it leaves the constraint
 * NULL (engine-picks).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
} from "lucide-react";
import { IconTip } from "./Tip";
import {
  CONSTRAINT_AXES,
  PHASES,
  SELECTION_MODES,
  CONSTRAINT_KEYS,
  pickConstraints,
  constraintCount,
} from "./constants";
import { useAxisDistribution } from "./hooks";

const ANY_VALUE = "__any__";

export default function PositionRow({
  position,
  index,
  templates = [],
  onSave,
  onDelete,
  saving,
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(() => normalisePosition(position));

  // When the upstream position changes (after save), refresh the draft.
  useEffect(() => {
    setDraft(normalisePosition(position));
  }, [position]);

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(normalisePosition(position)),
    [draft, position],
  );

  const summaryConstraints = useMemo(() => {
    const out = [];
    for (const axis of CONSTRAINT_AXES) {
      const v = draft[axis.key];
      if (v) out.push(`${axis.label.toLowerCase()}=${v}`);
    }
    return out;
  }, [draft]);

  const isOverridden = position?.is_overridden_at_cell;

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

        <span className="text-xs font-medium">
          {draft.space_type || draft.room_type || draft.image_type || "—"}
        </span>

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

          <div>
            <div className="text-[11px] font-semibold flex items-center gap-1 mb-1.5">
              Constraints
              <IconTip
                text="Set what you care about; leave NULL ('Any') to let the engine pick. Use the Taxonomy Explorer subtab to see counts and samples for each value."
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {CONSTRAINT_AXES.map((axis) => (
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

          <div>
            <Label className="text-[11px]">Notes</Label>
            <Textarea
              className="text-xs min-h-[48px]"
              placeholder="Optional free-text note (visible to operators only)."
              value={draft.notes || ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, notes: e.target.value }))
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
                  // Apply heuristics — slot_definitions only carry
                  // eligible_room_types so we map that to room_type when
                  // the template lists exactly one entry.
                  room_type:
                    Array.isArray(t.eligible_room_types) && t.eligible_room_types.length === 1
                      ? t.eligible_room_types[0]
                      : d.room_type,
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

function ConstraintPicker({ axis, value, onChange, testIdPrefix }) {
  const { data = [], isLoading } = useAxisDistribution(axis.key);
  const items = data;

  return (
    <div>
      <Label className="text-[11px] flex items-center gap-1">
        {axis.label}
        {axis.legacy && (
          <Badge variant="outline" className="text-[9px] py-0 px-1">
            legacy
          </Badge>
        )}
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
              <span>{row.value}</span>
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

function normalisePosition(position) {
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
    notes: position?.notes || "",
    ...pickConstraints(position),
  };
  // Ensure every constraint axis is present (even if NULL).
  for (const k of CONSTRAINT_KEYS) {
    if (!(k in base)) base[k] = null;
  }
  return base;
}

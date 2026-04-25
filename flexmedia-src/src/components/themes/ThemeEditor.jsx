/**
 * ThemeEditor — Drone Phase 4 Stream J
 *
 * Form for creating + editing a drone theme. Per IMPLEMENTATION_PLAN_V2.md §6.4:
 *   - Left: section nav (collapsible accordion)
 *   - Centre: form for active section
 *   - Right: live preview placeholder (Wave 3 polish)
 *   - Top bar: theme name + [Save] [Save as new] [Cancel]
 *
 * Backend wiring:
 *   - INSERT/UPDATE: api.functions.invoke('setDroneTheme', { theme_id?, owner_kind, owner_id, name, config, is_default })
 *   - LOAD existing: api.entities.DroneTheme.get(themeId)
 *
 * Form pattern: controlled inputs with local state. Repo uses this pattern in
 * BrandingPreferencesModule, AgencyDetailsEditor, ConfirmDialog, etc — checked
 * 3 forms before settling. (react-hook-form is in package.json but unused.)
 *
 * Permissions are gated by the parent (ThemeBrandingSubtab); this component
 * trusts its caller. Save is also gated server-side by setDroneTheme.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Save,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  ImageIcon,
  Trash2,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Defaults: derived from modal/drone_render/themes/flexmedia_default.json ──
// Users start with a sensible, fully-populated config so every form field is
// editable from the get-go. Saves only the user's chosen values; the inheritance
// chain in themeResolver fills missing keys at render time.
const DEFAULT_CONFIG = {
  theme_name: "",
  version: "1.0",
  inherits_from: null,

  anchor_line: {
    shape: "thin",
    width_px: 3,
    color: "#FFFFFF",
    opacity: 1.0,
    end_marker: {
      shape: "dot",
      size_px: 14,
      fill_color: "#FFFFFF",
      stroke_color: "#FFFFFF",
      stroke_width_px: 0,
    },
    min_length_px: 40,
    max_length_px: 220,
    flip_below_target_threshold_px: 80,
  },

  poi_label: {
    shape: "rectangle",
    corner_radius_px: 0,
    fill: "#FFFFFF",
    border: { color: null, width_px: 0 },
    padding_px: { top: 12, right: 24, bottom: 12, left: 24 },
    text_color: "#000000",
    text_case: "uppercase",
    font_family: "DejaVu Sans",
    font_size_px: 36,
    letter_spacing: 0,
    line_height: 1.2,
    text_template: "{name}",
    secondary_text: { enabled: false, template: "{distance}", color: "#666666" },
  },

  property_pin: {
    mode: "line_up_with_house_icon",
    size_px: 120,
    fill_color: "#FFFFFF",
    stroke_color: "#000000",
    stroke_width_px: 3,
    content: {
      type: "icon",
      text: "",
      monogram: "",
      icon_name: "home",
      logo_asset_ref: "",
      text_color: "#000000",
      text_font: "DejaVu Sans",
      text_size_px: 30,
      icon_color: "#000000",
    },
    address_label: {
      enabled: false,
      position: "below",
      text_color: "#FFFFFF",
      bg_color: "#000000",
      font_size_px: 24,
    },
  },

  boundary: {
    enabled: false,
    line: {
      style: "solid",
      width_px: 6,
      color: "#FFFFFF",
      corner_radius_px: 0,
      shadow: {
        enabled: true,
        color: "#000000",
        offset_x_px: 0,
        offset_y_px: 4,
        blur_px: 6,
      },
    },
    exterior_treatment: {
      blur_enabled: false,
      blur_strength_px: 0,
      darken_factor: 1.0,
      hue_shift_degrees: 0,
      saturation_factor: 1.0,
      lightness_factor: 1.0,
    },
    side_measurements: {
      enabled: true,
      unit: "metres",
      decimals: 1,
      position: "outside",
      text_color: "#FFFFFF",
      text_outline_color: "#000000",
      text_outline_width_px: 3,
      font_size_px: 28,
      font_family: "DejaVu Sans",
    },
    sqm_total: {
      enabled: true,
      text_template: "{sqm} sqm approx",
      position: "centroid",
      text_color: "#FFFFFF",
      bg_color: "transparent",
      font_size_px: 64,
      shadow: {
        enabled: true,
        color: "#000000",
        offset_x_px: 2,
        offset_y_px: 4,
        blur_px: 8,
      },
    },
    address_overlay: {
      enabled: false,
      position: "below_sqm",
      text_template: "{street_number} {street_name}",
      text_color: "#FFFFFF",
      font_size_px: 36,
      shadow_enabled: true,
    },
  },

  poi_selection: {
    radius_m: 1500,
    max_pins_per_shot: 6,
    min_separation_px: 220,
    curation: "auto",
    type_quotas: {
      beach: { priority: 1, max: 1 },
      shopping: { priority: 2, max: 1 },
      school: { priority: 3, max: 2 },
      train: { priority: 4, max: 2 },
      hospital: { priority: 5, max: 1 },
    },
  },

  branding_ribbon: {
    enabled: false,
    position: "bottom",
    height_px: 80,
    bg_color: "#000000",
    text_color: "#FFFFFF",
    show_org_logo: false,
    logo_asset_ref: "",
    logo_position: "left",
    logo_height_px: 60,
    show_address: true,
    address_font_size_px: 28,
    show_shot_id: false,
  },

  output_variants: [
    {
      name: "mls_web",
      format: "JPEG",
      quality: 88,
      target_width_px: 2400,
      aspect: "preserve",
      max_bytes: 4000000,
      color_profile: "sRGB",
    },
  ],
};

// ── Section nav metadata ────────────────────────────────────────────────────
const SECTIONS = [
  { id: "anchor_line", label: "Anchor line" },
  { id: "poi_label", label: "POI label" },
  { id: "property_pin", label: "Property pin" },
  { id: "boundary", label: "Boundary" },
  { id: "poi_selection", label: "POI selection" },
  { id: "branding_ribbon", label: "Branding ribbon" },
  { id: "output_variants", label: "Output variants" },
  { id: "safety_rules", label: "Safety rules" },
];

const PROPERTY_PIN_MODES = [
  { value: "pill_with_address", label: "Pill with address" },
  { value: "teardrop_with_logo", label: "Teardrop with logo" },
  { value: "teardrop_with_monogram", label: "Teardrop with monogram" },
  { value: "teardrop_with_icon", label: "Teardrop with icon" },
  { value: "teardrop_plain", label: "Teardrop plain" },
  { value: "line_up_with_house_icon", label: "Line up with house icon" },
];

// ── Tiny helpers ───────────────────────────────────────────────────────────
const setDeep = (obj, path, value) => {
  const next = { ...obj };
  let cursor = next;
  for (let i = 0; i < path.length - 1; i++) {
    cursor[path[i]] = { ...(cursor[path[i]] || {}) };
    cursor = cursor[path[i]];
  }
  cursor[path[path.length - 1]] = value;
  return next;
};

const isHex = (v) => typeof v === "string" && /^#([0-9a-fA-F]{3}){1,2}$/.test(v);

// Read-only display for system safety rules. Editing is out of scope for v1.
const SYSTEM_SAFETY_RULES = [
  {
    id: "anchor_must_not_overlap_pin",
    message: "Anchor lines must not visually overlap the property pin",
    enforcement: "error",
  },
  {
    id: "min_label_separation",
    message: "Adjacent POI labels must respect min_separation_px",
    enforcement: "warning",
  },
  {
    id: "boundary_within_frame",
    message: "Boundary polygon must lie fully within image frame",
    enforcement: "warning",
  },
];

// ── Field components (small, generic) ──────────────────────────────────────

function FieldRow({ label, hint, children, className }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 md:grid-cols-[180px_1fr] gap-2 md:gap-4 items-start py-1.5",
        className,
      )}
    >
      <div className="pt-1.5">
        <Label className="text-xs font-medium text-foreground">{label}</Label>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ColorField({ value, onChange, allowNull = false }) {
  const safeValue = isHex(value) ? value : "#000000";
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={safeValue}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-12 rounded border border-input cursor-pointer bg-background p-0.5"
      />
      <Input
        type="text"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || (allowNull ? null : "#000000"))}
        placeholder={allowNull ? "(none)" : "#RRGGBB"}
        className="h-8 text-xs font-mono w-32"
      />
      {!isHex(value) && value !== null && value !== "" && value !== "transparent" && (
        <span className="text-[10px] text-amber-600">invalid hex</span>
      )}
    </div>
  );
}

function NumberField({ value, onChange, min, max, step = 1, suffix }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="h-8 text-xs w-32"
      />
      {suffix && <span className="text-[10px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function SwitchField({ value, onChange, label }) {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={!!value} onCheckedChange={onChange} />
      <span className="text-xs text-muted-foreground">{label || (value ? "Enabled" : "Disabled")}</span>
    </div>
  );
}

function SelectField({ value, onChange, options, placeholder }) {
  return (
    <Select value={value ?? ""} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs w-56">
        <SelectValue placeholder={placeholder || "Select…"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => {
          const v = typeof o === "string" ? o : o.value;
          const l = typeof o === "string" ? o : o.label;
          return (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function TextField({ value, onChange, placeholder, mono }) {
  return (
    <Input
      type="text"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn("h-8 text-xs", mono && "font-mono")}
    />
  );
}

function SectionAccordion({ id, label, openId, onToggle, children, badge }) {
  const open = openId === id;
  return (
    <Collapsible open={open} onOpenChange={(next) => onToggle(next ? id : null)}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left rounded-md transition-colors",
            open ? "bg-muted" : "hover:bg-muted/50",
          )}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            {label}
          </span>
          {badge && (
            <Badge variant="outline" className="text-[9px] font-normal">
              {badge}
            </Badge>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1 space-y-1 border-l-2 border-muted ml-2 mt-0.5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ThemeEditor({
  themeId,
  ownerKind,
  ownerId,
  initialTheme,
  onSaved,
  onCancel,
  canEdit = true,
}) {
  const [name, setName] = useState("");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [isDefault, setIsDefault] = useState(false);
  const [version, setVersion] = useState(null);
  const [openSection, setOpenSection] = useState("anchor_line");
  const [loading, setLoading] = useState(!!themeId);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // ── Hydrate from existing theme (edit) or from initialTheme prop (duplicate) ──
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      if (initialTheme) {
        setName(initialTheme.name || "");
        setConfig({ ...DEFAULT_CONFIG, ...(initialTheme.config || {}) });
        setIsDefault(!!initialTheme.is_default);
        setVersion(initialTheme.version || null);
        return;
      }
      if (!themeId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const row = await api.entities.DroneTheme.get(themeId);
        if (cancelled) return;
        setName(row.name || "");
        setConfig({ ...DEFAULT_CONFIG, ...(row.config || {}) });
        setIsDefault(!!row.is_default);
        setVersion(row.version || null);
      } catch (e) {
        if (!cancelled) setLoadError(e?.message || "Failed to load theme");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    hydrate();
    return () => {
      cancelled = true;
    };
  }, [themeId, initialTheme]);

  // Update a deep path inside `config`
  const update = useCallback((path, value) => {
    setConfig((prev) => setDeep(prev, path, value));
  }, []);

  // ── Save handlers ────────────────────────────────────────────────────────
  const saveTheme = useCallback(
    async ({ saveAsNew = false }) => {
      if (!name?.trim()) {
        toast.error("Theme name is required");
        return;
      }
      if (!canEdit) {
        toast.error("You don't have permission to save this theme");
        return;
      }
      setSaving(true);
      try {
        // saveAsNew → strip theme_id so backend creates a new row
        const payload = {
          owner_kind: ownerKind,
          owner_id: ownerId,
          name: name.trim(),
          config: { ...config, theme_name: name.trim() },
          is_default: isDefault,
        };
        if (themeId && !saveAsNew) {
          payload.theme_id = themeId;
        }
        const result = await api.functions.invoke("setDroneTheme", payload);
        const data = result?.data;
        if (!data?.success) {
          throw new Error(data?.error || "Save failed");
        }
        toast.success(saveAsNew ? "Theme created" : "Theme saved");
        onSaved?.({
          theme_id: data.theme_id,
          version: data.version,
          name: name.trim(),
          is_default: isDefault,
        });
      } catch (e) {
        toast.error(e?.message || "Failed to save theme");
      } finally {
        setSaving(false);
      }
    },
    [name, config, isDefault, themeId, ownerKind, ownerId, canEdit, onSaved],
  );

  // ── Output variants helpers ──────────────────────────────────────────────
  const variants = config.output_variants || [];
  const addVariant = () =>
    update(
      ["output_variants"],
      [
        ...variants,
        {
          name: `variant_${variants.length + 1}`,
          format: "JPEG",
          quality: 88,
          target_width_px: 2400,
          aspect: "preserve",
          max_bytes: 4000000,
          color_profile: "sRGB",
        },
      ],
    );
  const removeVariant = (idx) =>
    update(["output_variants"], variants.filter((_, i) => i !== idx));
  const updateVariant = (idx, key, value) =>
    update(
      ["output_variants"],
      variants.map((v, i) => (i === idx ? { ...v, [key]: value } : v)),
    );

  // ── Type-quotas helpers ──────────────────────────────────────────────────
  const quotas = config.poi_selection?.type_quotas || {};
  const quotaEntries = useMemo(() => Object.entries(quotas), [quotas]);
  const updateQuota = (typeName, key, value) =>
    update(["poi_selection", "type_quotas", typeName, key], value);
  const renameQuotaType = (oldName, newName) => {
    if (!newName || newName === oldName || quotas[newName]) return;
    const next = {};
    for (const [k, v] of Object.entries(quotas)) {
      next[k === oldName ? newName : k] = v;
    }
    update(["poi_selection", "type_quotas"], next);
  };
  const removeQuotaType = (typeName) => {
    const { [typeName]: _, ...rest } = quotas;
    update(["poi_selection", "type_quotas"], rest);
  };
  const addQuotaType = () => {
    let i = 1;
    let name = "new_type";
    while (quotas[name]) name = `new_type_${i++}`;
    update(["poi_selection", "type_quotas", name], { priority: 99, max: 1 });
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Card>
        <CardContent className="p-12 flex items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading theme…
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900/50">
        <CardContent className="p-6 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800 dark:text-red-200">
              Couldn't load theme
            </p>
            <p className="text-xs text-red-700 dark:text-red-300 mt-1">{loadError}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={onCancel}>
              Close
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex-1 min-w-0 space-y-1">
            <Label className="text-xs font-medium">Theme name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My agency dark theme"
              disabled={!canEdit}
              className="h-9 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-2 px-2 py-1 rounded-md border border-input bg-background">
              <Switch
                checked={isDefault}
                onCheckedChange={setIsDefault}
                disabled={!canEdit}
                id="is-default-switch"
              />
              <Label htmlFor="is-default-switch" className="text-xs cursor-pointer">
                Set as default
              </Label>
            </div>
            {version != null && (
              <Badge variant="outline" className="text-[10px] font-normal">
                v{version}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            {themeId && canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => saveTheme({ saveAsNew: true })}
                disabled={saving || !name.trim()}
                title="Save as a new theme (preserves the original)"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                Save as new
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                onClick={() => saveTheme({ saveAsNew: false })}
                disabled={saving || !name.trim()}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                )}
                Save
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Two-pane layout: form left, preview placeholder right ────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3">
        {/* Form column */}
        <Card>
          <CardContent className="p-3 space-y-1">
            {/* Anchor line */}
            <SectionAccordion
              id="anchor_line"
              label="Anchor line"
              openId={openSection}
              onToggle={setOpenSection}
            >
              <FieldRow label="Shape">
                <SelectField
                  value={config.anchor_line?.shape}
                  onChange={(v) => update(["anchor_line", "shape"], v)}
                  options={["thin", "thick_bar", "dashed"]}
                />
              </FieldRow>
              <FieldRow label="Width" hint="pixels">
                <NumberField
                  value={config.anchor_line?.width_px}
                  onChange={(v) => update(["anchor_line", "width_px"], v)}
                  min={1}
                  max={50}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Color">
                <ColorField
                  value={config.anchor_line?.color}
                  onChange={(v) => update(["anchor_line", "color"], v)}
                />
              </FieldRow>
              <FieldRow label="Opacity" hint="0.0 – 1.0">
                <NumberField
                  value={config.anchor_line?.opacity}
                  onChange={(v) => update(["anchor_line", "opacity"], v)}
                  min={0}
                  max={1}
                  step={0.05}
                />
              </FieldRow>

              <div className="mt-3 pt-2 border-t border-dashed border-muted">
                <p className="text-xs font-semibold text-muted-foreground mb-1">End marker</p>
                <FieldRow label="Shape">
                  <SelectField
                    value={config.anchor_line?.end_marker?.shape}
                    onChange={(v) => update(["anchor_line", "end_marker", "shape"], v)}
                    options={["none", "dot", "diamond", "circle", "cross"]}
                  />
                </FieldRow>
                <FieldRow label="Size">
                  <NumberField
                    value={config.anchor_line?.end_marker?.size_px}
                    onChange={(v) => update(["anchor_line", "end_marker", "size_px"], v)}
                    min={0}
                    max={100}
                    suffix="px"
                  />
                </FieldRow>
                <FieldRow label="Fill color">
                  <ColorField
                    value={config.anchor_line?.end_marker?.fill_color}
                    onChange={(v) => update(["anchor_line", "end_marker", "fill_color"], v)}
                  />
                </FieldRow>
                <FieldRow label="Stroke color">
                  <ColorField
                    value={config.anchor_line?.end_marker?.stroke_color}
                    onChange={(v) => update(["anchor_line", "end_marker", "stroke_color"], v)}
                  />
                </FieldRow>
                <FieldRow label="Stroke width">
                  <NumberField
                    value={config.anchor_line?.end_marker?.stroke_width_px}
                    onChange={(v) => update(["anchor_line", "end_marker", "stroke_width_px"], v)}
                    min={0}
                    max={20}
                    suffix="px"
                  />
                </FieldRow>
              </div>
            </SectionAccordion>

            {/* POI label */}
            <SectionAccordion
              id="poi_label"
              label="POI label"
              openId={openSection}
              onToggle={setOpenSection}
            >
              <FieldRow label="Shape">
                <SelectField
                  value={config.poi_label?.shape}
                  onChange={(v) => update(["poi_label", "shape"], v)}
                  options={["rectangle", "rounded_rectangle", "pill"]}
                />
              </FieldRow>
              <FieldRow label="Corner radius">
                <NumberField
                  value={config.poi_label?.corner_radius_px}
                  onChange={(v) => update(["poi_label", "corner_radius_px"], v)}
                  min={0}
                  max={64}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Fill" hint='hex or "transparent"'>
                <ColorField
                  value={config.poi_label?.fill}
                  onChange={(v) => update(["poi_label", "fill"], v)}
                />
              </FieldRow>
              <FieldRow label="Text color">
                <ColorField
                  value={config.poi_label?.text_color}
                  onChange={(v) => update(["poi_label", "text_color"], v)}
                />
              </FieldRow>
              <FieldRow label="Text case">
                <SelectField
                  value={config.poi_label?.text_case}
                  onChange={(v) => update(["poi_label", "text_case"], v)}
                  options={["asis", "uppercase", "titlecase"]}
                />
              </FieldRow>
              <FieldRow label="Font size">
                <NumberField
                  value={config.poi_label?.font_size_px}
                  onChange={(v) => update(["poi_label", "font_size_px"], v)}
                  min={6}
                  max={200}
                  suffix="px"
                />
              </FieldRow>

              <div className="mt-3 pt-2 border-t border-dashed border-muted">
                <p className="text-xs font-semibold text-muted-foreground mb-1">Padding</p>
                <FieldRow label="Top">
                  <NumberField
                    value={config.poi_label?.padding_px?.top}
                    onChange={(v) => update(["poi_label", "padding_px", "top"], v)}
                    min={0}
                    suffix="px"
                  />
                </FieldRow>
                <FieldRow label="Right">
                  <NumberField
                    value={config.poi_label?.padding_px?.right}
                    onChange={(v) => update(["poi_label", "padding_px", "right"], v)}
                    min={0}
                    suffix="px"
                  />
                </FieldRow>
                <FieldRow label="Bottom">
                  <NumberField
                    value={config.poi_label?.padding_px?.bottom}
                    onChange={(v) => update(["poi_label", "padding_px", "bottom"], v)}
                    min={0}
                    suffix="px"
                  />
                </FieldRow>
                <FieldRow label="Left">
                  <NumberField
                    value={config.poi_label?.padding_px?.left}
                    onChange={(v) => update(["poi_label", "padding_px", "left"], v)}
                    min={0}
                    suffix="px"
                  />
                </FieldRow>
              </div>

              <div className="mt-3 pt-2 border-t border-dashed border-muted">
                <p className="text-xs font-semibold text-muted-foreground mb-1">Border</p>
                <FieldRow label="Color">
                  <ColorField
                    value={config.poi_label?.border?.color}
                    onChange={(v) => update(["poi_label", "border", "color"], v)}
                    allowNull
                  />
                </FieldRow>
                <FieldRow label="Width">
                  <NumberField
                    value={config.poi_label?.border?.width_px}
                    onChange={(v) => update(["poi_label", "border", "width_px"], v)}
                    min={0}
                    max={20}
                    suffix="px"
                  />
                </FieldRow>
              </div>

              <div className="mt-3 pt-2 border-t border-dashed border-muted">
                <p className="text-xs font-semibold text-muted-foreground mb-1">
                  Secondary text
                </p>
                <FieldRow label="Enabled">
                  <SwitchField
                    value={config.poi_label?.secondary_text?.enabled}
                    onChange={(v) => update(["poi_label", "secondary_text", "enabled"], v)}
                  />
                </FieldRow>
                {config.poi_label?.secondary_text?.enabled && (
                  <>
                    <FieldRow label="Template">
                      <TextField
                        value={config.poi_label?.secondary_text?.template}
                        onChange={(v) =>
                          update(["poi_label", "secondary_text", "template"], v)
                        }
                        placeholder="{distance}"
                        mono
                      />
                    </FieldRow>
                    <FieldRow label="Color">
                      <ColorField
                        value={config.poi_label?.secondary_text?.color}
                        onChange={(v) =>
                          update(["poi_label", "secondary_text", "color"], v)
                        }
                      />
                    </FieldRow>
                  </>
                )}
              </div>
            </SectionAccordion>

            {/* Property pin */}
            <SectionAccordion
              id="property_pin"
              label="Property pin"
              openId={openSection}
              onToggle={setOpenSection}
            >
              <FieldRow label="Mode">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {PROPERTY_PIN_MODES.map((m) => (
                    <label
                      key={m.value}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs border cursor-pointer transition-colors",
                        config.property_pin?.mode === m.value
                          ? "border-primary bg-primary/5"
                          : "border-input hover:bg-muted",
                      )}
                    >
                      <input
                        type="radio"
                        name="pin-mode"
                        value={m.value}
                        checked={config.property_pin?.mode === m.value}
                        onChange={() => update(["property_pin", "mode"], m.value)}
                        className="h-3 w-3"
                      />
                      <span className="truncate">{m.label}</span>
                    </label>
                  ))}
                </div>
              </FieldRow>
              <FieldRow label="Size">
                <NumberField
                  value={config.property_pin?.size_px}
                  onChange={(v) => update(["property_pin", "size_px"], v)}
                  min={20}
                  max={400}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Fill color">
                <ColorField
                  value={config.property_pin?.fill_color}
                  onChange={(v) => update(["property_pin", "fill_color"], v)}
                />
              </FieldRow>
              <FieldRow label="Stroke color">
                <ColorField
                  value={config.property_pin?.stroke_color}
                  onChange={(v) => update(["property_pin", "stroke_color"], v)}
                />
              </FieldRow>
              <FieldRow label="Stroke width">
                <NumberField
                  value={config.property_pin?.stroke_width_px}
                  onChange={(v) => update(["property_pin", "stroke_width_px"], v)}
                  min={0}
                  max={20}
                  suffix="px"
                />
              </FieldRow>

              <div className="mt-3 pt-2 border-t border-dashed border-muted">
                <p className="text-xs font-semibold text-muted-foreground mb-1">Content</p>
                <FieldRow label="Type">
                  <SelectField
                    value={config.property_pin?.content?.type}
                    onChange={(v) => update(["property_pin", "content", "type"], v)}
                    options={["none", "text", "logo", "monogram", "icon"]}
                  />
                </FieldRow>
                {config.property_pin?.content?.type === "text" && (
                  <FieldRow label="Text">
                    <TextField
                      value={config.property_pin?.content?.text}
                      onChange={(v) => update(["property_pin", "content", "text"], v)}
                    />
                  </FieldRow>
                )}
                {config.property_pin?.content?.type === "monogram" && (
                  <FieldRow label="Monogram">
                    <TextField
                      value={config.property_pin?.content?.monogram}
                      onChange={(v) => update(["property_pin", "content", "monogram"], v)}
                      placeholder="e.g. AB"
                    />
                  </FieldRow>
                )}
                {config.property_pin?.content?.type === "icon" && (
                  <FieldRow label="Icon name">
                    <TextField
                      value={config.property_pin?.content?.icon_name}
                      onChange={(v) => update(["property_pin", "content", "icon_name"], v)}
                      placeholder="home"
                      mono
                    />
                  </FieldRow>
                )}
                {config.property_pin?.content?.type === "logo" && (
                  <FieldRow label="Logo asset" hint="Dropbox path (placeholder)">
                    <div className="flex items-center gap-2 w-full">
                      <Input
                        value={config.property_pin?.content?.logo_asset_ref ?? ""}
                        onChange={(e) =>
                          update(
                            ["property_pin", "content", "logo_asset_ref"],
                            e.target.value,
                          )
                        }
                        placeholder="/FlexMedia/Brands/.../logo.svg"
                        className="h-8 text-xs font-mono"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled
                        title="File picker integration: Wave 3"
                      >
                        <ImageIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </FieldRow>
                )}
                {(config.property_pin?.content?.type === "text" ||
                  config.property_pin?.content?.type === "monogram") && (
                  <>
                    <FieldRow label="Text color">
                      <ColorField
                        value={config.property_pin?.content?.text_color}
                        onChange={(v) =>
                          update(["property_pin", "content", "text_color"], v)
                        }
                      />
                    </FieldRow>
                    <FieldRow label="Text size">
                      <NumberField
                        value={config.property_pin?.content?.text_size_px}
                        onChange={(v) =>
                          update(["property_pin", "content", "text_size_px"], v)
                        }
                        min={6}
                        max={120}
                        suffix="px"
                      />
                    </FieldRow>
                  </>
                )}
                {config.property_pin?.content?.type === "icon" && (
                  <FieldRow label="Icon color">
                    <ColorField
                      value={config.property_pin?.content?.icon_color}
                      onChange={(v) => update(["property_pin", "content", "icon_color"], v)}
                    />
                  </FieldRow>
                )}
              </div>

              <div className="mt-3 pt-2 border-t border-dashed border-muted">
                <p className="text-xs font-semibold text-muted-foreground mb-1">
                  Address label
                </p>
                <FieldRow label="Enabled">
                  <SwitchField
                    value={config.property_pin?.address_label?.enabled}
                    onChange={(v) =>
                      update(["property_pin", "address_label", "enabled"], v)
                    }
                  />
                </FieldRow>
                {config.property_pin?.address_label?.enabled && (
                  <>
                    <FieldRow label="Position">
                      <SelectField
                        value={config.property_pin?.address_label?.position}
                        onChange={(v) =>
                          update(["property_pin", "address_label", "position"], v)
                        }
                        options={["below", "above", "none"]}
                      />
                    </FieldRow>
                    <FieldRow label="Text color">
                      <ColorField
                        value={config.property_pin?.address_label?.text_color}
                        onChange={(v) =>
                          update(["property_pin", "address_label", "text_color"], v)
                        }
                      />
                    </FieldRow>
                    <FieldRow label="Background">
                      <ColorField
                        value={config.property_pin?.address_label?.bg_color}
                        onChange={(v) =>
                          update(["property_pin", "address_label", "bg_color"], v)
                        }
                      />
                    </FieldRow>
                    <FieldRow label="Font size">
                      <NumberField
                        value={config.property_pin?.address_label?.font_size_px}
                        onChange={(v) =>
                          update(["property_pin", "address_label", "font_size_px"], v)
                        }
                        min={6}
                        max={120}
                        suffix="px"
                      />
                    </FieldRow>
                  </>
                )}
              </div>
            </SectionAccordion>

            {/* Boundary */}
            <SectionAccordion
              id="boundary"
              label="Boundary"
              openId={openSection}
              onToggle={setOpenSection}
              badge={config.boundary?.enabled ? "On" : "Off"}
            >
              <FieldRow label="Enabled">
                <SwitchField
                  value={config.boundary?.enabled}
                  onChange={(v) => update(["boundary", "enabled"], v)}
                />
              </FieldRow>

              {config.boundary?.enabled && (
                <>
                  <div className="mt-3 pt-2 border-t border-dashed border-muted">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">Line</p>
                    <FieldRow label="Style">
                      <SelectField
                        value={config.boundary?.line?.style}
                        onChange={(v) => update(["boundary", "line", "style"], v)}
                        options={["solid", "dashed", "dotted"]}
                      />
                    </FieldRow>
                    <FieldRow label="Width">
                      <NumberField
                        value={config.boundary?.line?.width_px}
                        onChange={(v) => update(["boundary", "line", "width_px"], v)}
                        min={1}
                        max={50}
                        suffix="px"
                      />
                    </FieldRow>
                    <FieldRow label="Color">
                      <ColorField
                        value={config.boundary?.line?.color}
                        onChange={(v) => update(["boundary", "line", "color"], v)}
                      />
                    </FieldRow>
                    <FieldRow label="Corner radius">
                      <NumberField
                        value={config.boundary?.line?.corner_radius_px}
                        onChange={(v) =>
                          update(["boundary", "line", "corner_radius_px"], v)
                        }
                        min={0}
                        max={100}
                        suffix="px"
                      />
                    </FieldRow>
                    <FieldRow label="Shadow">
                      <SwitchField
                        value={config.boundary?.line?.shadow?.enabled}
                        onChange={(v) =>
                          update(["boundary", "line", "shadow", "enabled"], v)
                        }
                      />
                    </FieldRow>
                  </div>

                  <div className="mt-3 pt-2 border-t border-dashed border-muted">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">
                      Exterior treatment
                    </p>
                    <FieldRow label="Blur">
                      <SwitchField
                        value={config.boundary?.exterior_treatment?.blur_enabled}
                        onChange={(v) =>
                          update(["boundary", "exterior_treatment", "blur_enabled"], v)
                        }
                      />
                    </FieldRow>
                    {config.boundary?.exterior_treatment?.blur_enabled && (
                      <FieldRow label="Blur strength">
                        <NumberField
                          value={config.boundary?.exterior_treatment?.blur_strength_px}
                          onChange={(v) =>
                            update(
                              ["boundary", "exterior_treatment", "blur_strength_px"],
                              v,
                            )
                          }
                          min={0}
                          max={50}
                          suffix="px"
                        />
                      </FieldRow>
                    )}
                    <FieldRow label="Darken" hint="0.0 – 1.0 (1 = unchanged)">
                      <NumberField
                        value={config.boundary?.exterior_treatment?.darken_factor}
                        onChange={(v) =>
                          update(["boundary", "exterior_treatment", "darken_factor"], v)
                        }
                        min={0}
                        max={1}
                        step={0.05}
                      />
                    </FieldRow>
                    <FieldRow label="Hue shift" hint="-180 to +180">
                      <NumberField
                        value={config.boundary?.exterior_treatment?.hue_shift_degrees}
                        onChange={(v) =>
                          update(
                            ["boundary", "exterior_treatment", "hue_shift_degrees"],
                            v,
                          )
                        }
                        min={-180}
                        max={180}
                      />
                    </FieldRow>
                    <FieldRow label="Saturation" hint="0.0 = grayscale">
                      <NumberField
                        value={config.boundary?.exterior_treatment?.saturation_factor}
                        onChange={(v) =>
                          update(
                            ["boundary", "exterior_treatment", "saturation_factor"],
                            v,
                          )
                        }
                        min={0}
                        max={3}
                        step={0.05}
                      />
                    </FieldRow>
                    <FieldRow label="Lightness">
                      <NumberField
                        value={config.boundary?.exterior_treatment?.lightness_factor}
                        onChange={(v) =>
                          update(
                            ["boundary", "exterior_treatment", "lightness_factor"],
                            v,
                          )
                        }
                        min={0}
                        max={3}
                        step={0.05}
                      />
                    </FieldRow>
                  </div>

                  <div className="mt-3 pt-2 border-t border-dashed border-muted">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">
                      Side measurements
                    </p>
                    <FieldRow label="Enabled">
                      <SwitchField
                        value={config.boundary?.side_measurements?.enabled}
                        onChange={(v) =>
                          update(["boundary", "side_measurements", "enabled"], v)
                        }
                      />
                    </FieldRow>
                    {config.boundary?.side_measurements?.enabled && (
                      <>
                        <FieldRow label="Unit">
                          <SelectField
                            value={config.boundary?.side_measurements?.unit}
                            onChange={(v) =>
                              update(["boundary", "side_measurements", "unit"], v)
                            }
                            options={["metres", "feet"]}
                          />
                        </FieldRow>
                        <FieldRow label="Decimals">
                          <NumberField
                            value={config.boundary?.side_measurements?.decimals}
                            onChange={(v) =>
                              update(["boundary", "side_measurements", "decimals"], v)
                            }
                            min={0}
                            max={4}
                          />
                        </FieldRow>
                        <FieldRow label="Position">
                          <SelectField
                            value={config.boundary?.side_measurements?.position}
                            onChange={(v) =>
                              update(["boundary", "side_measurements", "position"], v)
                            }
                            options={["outside", "inside"]}
                          />
                        </FieldRow>
                      </>
                    )}
                  </div>

                  <div className="mt-3 pt-2 border-t border-dashed border-muted">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">
                      Sqm total
                    </p>
                    <FieldRow label="Enabled">
                      <SwitchField
                        value={config.boundary?.sqm_total?.enabled}
                        onChange={(v) => update(["boundary", "sqm_total", "enabled"], v)}
                      />
                    </FieldRow>
                  </div>

                  <div className="mt-3 pt-2 border-t border-dashed border-muted">
                    <p className="text-xs font-semibold text-muted-foreground mb-1">
                      Address overlay
                    </p>
                    <FieldRow label="Enabled">
                      <SwitchField
                        value={config.boundary?.address_overlay?.enabled}
                        onChange={(v) =>
                          update(["boundary", "address_overlay", "enabled"], v)
                        }
                      />
                    </FieldRow>
                  </div>
                </>
              )}
            </SectionAccordion>

            {/* POI selection */}
            <SectionAccordion
              id="poi_selection"
              label="POI selection"
              openId={openSection}
              onToggle={setOpenSection}
            >
              <FieldRow label="Radius" hint="metres">
                <NumberField
                  value={config.poi_selection?.radius_m}
                  onChange={(v) => update(["poi_selection", "radius_m"], v)}
                  min={50}
                  max={5000}
                  suffix="m"
                />
              </FieldRow>
              <FieldRow label="Max pins per shot">
                <NumberField
                  value={config.poi_selection?.max_pins_per_shot}
                  onChange={(v) => update(["poi_selection", "max_pins_per_shot"], v)}
                  min={0}
                  max={20}
                />
              </FieldRow>
              <FieldRow label="Min separation">
                <NumberField
                  value={config.poi_selection?.min_separation_px}
                  onChange={(v) => update(["poi_selection", "min_separation_px"], v)}
                  min={0}
                  max={2000}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Curation">
                <SelectField
                  value={config.poi_selection?.curation}
                  onChange={(v) => update(["poi_selection", "curation"], v)}
                  options={["auto", "manual_only"]}
                />
              </FieldRow>

              <div className="mt-3 pt-2 border-t border-dashed border-muted">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-muted-foreground">
                    Type quotas
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addQuotaType}
                    className="h-7 text-xs"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add type
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {quotaEntries.length === 0 && (
                    <p className="text-[10px] text-muted-foreground italic">
                      No type quotas defined.
                    </p>
                  )}
                  {quotaEntries.map(([typeName, q]) => (
                    <div
                      key={typeName}
                      className="grid grid-cols-[1fr_72px_72px_auto] gap-2 items-center"
                    >
                      <Input
                        value={typeName}
                        onChange={(e) => renameQuotaType(typeName, e.target.value.trim())}
                        className="h-8 text-xs font-mono"
                      />
                      <Input
                        type="number"
                        value={q.priority ?? ""}
                        onChange={(e) =>
                          updateQuota(typeName, "priority", Number(e.target.value))
                        }
                        placeholder="prio"
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        value={q.max ?? ""}
                        onChange={(e) =>
                          updateQuota(typeName, "max", Number(e.target.value))
                        }
                        placeholder="max"
                        className="h-8 text-xs"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeQuotaType(typeName)}
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </SectionAccordion>

            {/* Branding ribbon */}
            <SectionAccordion
              id="branding_ribbon"
              label="Branding ribbon"
              openId={openSection}
              onToggle={setOpenSection}
              badge={config.branding_ribbon?.enabled ? "On" : "Off"}
            >
              <FieldRow label="Enabled">
                <SwitchField
                  value={config.branding_ribbon?.enabled}
                  onChange={(v) => update(["branding_ribbon", "enabled"], v)}
                />
              </FieldRow>
              {config.branding_ribbon?.enabled && (
                <>
                  <FieldRow label="Position">
                    <SelectField
                      value={config.branding_ribbon?.position}
                      onChange={(v) => update(["branding_ribbon", "position"], v)}
                      options={["top", "bottom", "none"]}
                    />
                  </FieldRow>
                  <FieldRow label="Height">
                    <NumberField
                      value={config.branding_ribbon?.height_px}
                      onChange={(v) => update(["branding_ribbon", "height_px"], v)}
                      min={20}
                      max={400}
                      suffix="px"
                    />
                  </FieldRow>
                  <FieldRow label="Background">
                    <ColorField
                      value={config.branding_ribbon?.bg_color}
                      onChange={(v) => update(["branding_ribbon", "bg_color"], v)}
                    />
                  </FieldRow>
                  <FieldRow label="Text color">
                    <ColorField
                      value={config.branding_ribbon?.text_color}
                      onChange={(v) => update(["branding_ribbon", "text_color"], v)}
                    />
                  </FieldRow>
                  <FieldRow label="Show org logo">
                    <SwitchField
                      value={config.branding_ribbon?.show_org_logo}
                      onChange={(v) => update(["branding_ribbon", "show_org_logo"], v)}
                    />
                  </FieldRow>
                  {config.branding_ribbon?.show_org_logo && (
                    <FieldRow label="Logo asset" hint="Dropbox path (placeholder)">
                      <div className="flex items-center gap-2 w-full">
                        <Input
                          value={config.branding_ribbon?.logo_asset_ref ?? ""}
                          onChange={(e) =>
                            update(["branding_ribbon", "logo_asset_ref"], e.target.value)
                          }
                          placeholder="/FlexMedia/Brands/.../logo.png"
                          className="h-8 text-xs font-mono"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled
                          title="File picker integration: Wave 3"
                        >
                          <ImageIcon className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </FieldRow>
                  )}
                  <FieldRow label="Show address">
                    <SwitchField
                      value={config.branding_ribbon?.show_address}
                      onChange={(v) => update(["branding_ribbon", "show_address"], v)}
                    />
                  </FieldRow>
                  <FieldRow label="Show shot ID">
                    <SwitchField
                      value={config.branding_ribbon?.show_shot_id}
                      onChange={(v) => update(["branding_ribbon", "show_shot_id"], v)}
                    />
                  </FieldRow>
                </>
              )}
            </SectionAccordion>

            {/* Output variants */}
            <SectionAccordion
              id="output_variants"
              label="Output variants"
              openId={openSection}
              onToggle={setOpenSection}
              badge={`${variants.length}`}
            >
              <div className="space-y-2">
                {variants.length === 0 && (
                  <p className="text-[10px] text-muted-foreground italic">
                    No output variants defined.
                  </p>
                )}
                {variants.map((v, idx) => (
                  <div
                    key={idx}
                    className="rounded-md border border-input p-2.5 space-y-1.5 bg-muted/20"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <Badge variant="outline" className="text-[10px] font-normal">
                        Variant #{idx + 1}
                      </Badge>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeVariant(idx)}
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <FieldRow label="Name">
                      <TextField
                        value={v.name}
                        onChange={(val) => updateVariant(idx, "name", val)}
                      />
                    </FieldRow>
                    <FieldRow label="Format">
                      <SelectField
                        value={v.format}
                        onChange={(val) => updateVariant(idx, "format", val)}
                        options={["JPEG", "TIFF", "PNG"]}
                      />
                    </FieldRow>
                    <FieldRow label="Quality" hint="JPEG: 0–100">
                      <NumberField
                        value={v.quality}
                        onChange={(val) => updateVariant(idx, "quality", val)}
                        min={1}
                        max={100}
                      />
                    </FieldRow>
                    <FieldRow label="Width">
                      <NumberField
                        value={v.target_width_px}
                        onChange={(val) => updateVariant(idx, "target_width_px", val)}
                        min={100}
                        max={20000}
                        suffix="px"
                      />
                    </FieldRow>
                    <FieldRow label="Aspect">
                      <SelectField
                        value={v.aspect}
                        onChange={(val) => updateVariant(idx, "aspect", val)}
                        options={[
                          { value: "preserve", label: "Preserve" },
                          { value: "crop_1_1", label: "Crop 1:1" },
                          { value: "crop_16_9", label: "Crop 16:9" },
                          { value: "crop_4_5", label: "Crop 4:5" },
                        ]}
                      />
                    </FieldRow>
                    <FieldRow label="Max bytes">
                      <NumberField
                        value={v.max_bytes}
                        onChange={(val) => updateVariant(idx, "max_bytes", val)}
                        min={0}
                      />
                    </FieldRow>
                    <FieldRow label="Color profile">
                      <SelectField
                        value={v.color_profile}
                        onChange={(val) => updateVariant(idx, "color_profile", val)}
                        options={["sRGB", "Adobe_RGB"]}
                      />
                    </FieldRow>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addVariant}
                  className="w-full"
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add output variant
                </Button>
              </div>
            </SectionAccordion>

            {/* Safety rules — read-only system rules */}
            <SectionAccordion
              id="safety_rules"
              label="Safety rules"
              openId={openSection}
              onToggle={setOpenSection}
              badge="System"
            >
              <p className="text-[11px] text-muted-foreground mb-2">
                These are FlexMedia-managed render-safety rules. Editing arrives in a later
                release.
              </p>
              <div className="space-y-1.5">
                {SYSTEM_SAFETY_RULES.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-start gap-2 px-2.5 py-2 rounded-md bg-muted/40 border border-muted"
                  >
                    <ShieldAlert
                      className={cn(
                        "h-3.5 w-3.5 mt-0.5 shrink-0",
                        r.enforcement === "error" ? "text-red-500" : "text-amber-500",
                      )}
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{r.message}</p>
                      <p className="text-[10px] text-muted-foreground font-mono">
                        {r.id} · {r.enforcement}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </SectionAccordion>
          </CardContent>
        </Card>

        {/* Preview placeholder column */}
        <Card className="self-start lg:sticky lg:top-3 bg-muted/20">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Live preview
              </p>
              <Badge variant="outline" className="text-[9px] font-normal">
                Wave 3
              </Badge>
            </div>
            <div className="aspect-video rounded-md border border-dashed border-muted-foreground/30 flex items-center justify-center text-center px-3">
              <p className="text-[11px] text-muted-foreground">
                Live preview will load when you save once.
              </p>
            </div>
            <div className="text-[10px] text-muted-foreground space-y-0.5">
              <p>
                Preview rendering on three sample drone shots (nadir / oblique / orbital)
                will be wired up after this Wave's render-engine integration lands.
              </p>
              <p className="font-mono mt-2">
                {SECTIONS.length} sections · {variants.length} variant{variants.length === 1 ? "" : "s"}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

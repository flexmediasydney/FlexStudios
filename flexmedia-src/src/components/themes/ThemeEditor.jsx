/**
 * ThemeEditor — Drone Phase 4 Stream J (rev. 2026-04-25)
 *
 * Form for creating + editing a drone theme.
 *
 * Structural restructure (2026-04-25):
 *   - Sections grouped into "POI overlay" and "Nadir / Oblique render"
 *     so operators see which preview each setting affects.
 *   - Right column: 3-tab preview (Nadir / Oblique / POI) — client-side
 *     SVG mocks render live as the operator edits. The slower
 *     drone-render-preview Edge Function is kept as an opt-in "Render
 *     full preview (slow)" button per tab.
 *   - Save flow: when version_int > 1 (theme has been saved before), show
 *     an impact-confirmation dialog listing in-flight projects whose
 *     renders were produced from the prior version, with an opt-in
 *     "auto-re-render" path that fans out to drone-render with
 *     wipe_existing=true.
 *
 * Backend wiring:
 *   - INSERT/UPDATE: api.functions.invoke('setDroneTheme', { theme_id?, owner_kind, owner_id, name, config, is_default })
 *   - LOAD existing: api.entities.DroneTheme.get(themeId)
 *   - IMPACT (save dialog): api.rpc('drone_theme_impacted_projects', { p_theme_id })
 *   - RE-RENDER fan-out:    api.functions.invoke('drone-render', { shoot_id, wipe_existing: true })
 *
 * Subagent C will fill in the <HelpTip tip="..."> placeholders next to each field.
 *
 * Permissions are gated by the parent (ThemeBrandingSubtab); this component
 * trusts its caller. Save is also gated server-side by setDroneTheme.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { api } from "@/api/supabaseClient";
import debounce from "lodash/debounce";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Save,
  Plus,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  ImageIcon,
  Trash2,
  ShieldAlert,
  RefreshCw,
  Palette,
  Camera,
  Map as MapIcon,
  MousePointer,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HelpTip, HelpTipProvider } from "./HelpTip";

// ── Defaults: derived from modal/drone_render/themes/flexmedia_default.json ──
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
    enabled: true,
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
    secondary_text: { enabled: true, template: "{distance}", color: "#666666" },
  },

  property_pin: {
    enabled: true,
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
    // Canonical Google Places enum keys (post-migration 246). Operators
    // can de-select via the ThemeEditor's POI Selection > Type quotas
    // checklist; un-ticking a row removes its key entirely.
    type_quotas: {
      school:        { priority: 1, max: 2 },
      train_station: { priority: 2, max: 2 },
      hospital:      { priority: 3, max: 1 },
      shopping_mall: { priority: 4, max: 1 },
      park:          { priority: 5, max: 1 },
      beach:         { priority: 6, max: 1 },
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

// ── Section grouping (2026-04-25) ───────────────────────────────────────────
// Group sections by which preview each setting affects. The left sidebar nav
// renders two collapsible groups (POI overlay / Nadir / Oblique render).
const SECTIONS_BY_GROUP = {
  poi: [
    { id: "poi_selection", label: "POI selection (which POIs to fetch)" },
    { id: "anchor_line", label: "Anchor line (POI → label connector)" },
    { id: "poi_label", label: "POI label (style)" },
    // Renamed from "POI label foreground (advanced)" — that title implied
    // the section bound to `poi_label_foreground.*` keys, but every field
    // here is `poi_label.*` (typography knobs). The actual
    // poi_label_foreground.* outlined-text style is Wave 3. (Bug #6)
    { id: "poi_label_foreground", label: "POI label typography (advanced)" },
  ],
  render: [
    { id: "property_pin", label: "Property pin" },
    { id: "boundary", label: "Boundary outline" },
    { id: "branding_ribbon", label: "Branding ribbon" },
    { id: "output_variants", label: "Output variants" },
    { id: "safety_rules", label: "Safety rules (read-only)" },
  ],
};

// Bug #10 — `teardrop_with_logo` requires a logo asset upload UI which
// doesn't ship until Wave 3 (the `content.type='logo'` branch only
// renders a plain text input + a disabled file picker button). Hiding
// it here so operators don't pick a mode that silently has no asset
// path. Re-add once the asset picker lands.
const PROPERTY_PIN_MODES = [
  { value: "pill_with_address", label: "Pill with address" },
  { value: "teardrop_with_monogram", label: "Teardrop with monogram" },
  { value: "teardrop_with_icon", label: "Teardrop with icon" },
  { value: "teardrop_plain", label: "Teardrop plain" },
  { value: "line_up_with_house_icon", label: "Line up with house icon" },
];

// ── POI category options ──────────────────────────────────────────────────
// Drives the POI Selection > Type quotas checklist. `value` is the canonical
// Google Places enum that drone-pois passes verbatim to the Nearby Search
// API; the legacy 'shopping' / 'train' aliases are normalised in drone-pois
// for back-compat with pre-migration-246 themes. Defaults reflect the
// operator's preferred default ordering (schools > trains > hospitals >
// shopping > parks > beaches), with universities / stadiums / tourist
// attractions available as opt-ins.
const POI_TYPE_OPTIONS = [
  { value: "school",             label: "Schools",             defaultMax: 2, defaultPriority: 1 },
  { value: "train_station",      label: "Train stations",      defaultMax: 2, defaultPriority: 2 },
  { value: "hospital",           label: "Hospitals",           defaultMax: 1, defaultPriority: 3 },
  { value: "shopping_mall",      label: "Shopping centres",    defaultMax: 1, defaultPriority: 4 },
  { value: "park",               label: "Parks",               defaultMax: 1, defaultPriority: 5 },
  { value: "beach",              label: "Beaches",             defaultMax: 1, defaultPriority: 6 },
  { value: "university",         label: "Universities",        defaultMax: 1, defaultPriority: 7 },
  { value: "stadium",            label: "Stadiums",            defaultMax: 1, defaultPriority: 8 },
  { value: "tourist_attraction", label: "Tourist attractions", defaultMax: 1, defaultPriority: 9 },
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

// Paths whose value is a map/list keyed by user choice rather than a fixed
// schema — saved value must replace defaults wholly, never deep-merge.
// Otherwise an operator who de-selected an entry would see it resurrected
// from defaults on next load. `output_variants` is an array (also replaced
// wholly), but is listed here for documentation; arrays are handled by
// type below regardless of path.
const REPLACE_WHOLLY_PATHS = new Set([
  "poi_selection.type_quotas",
  "output_variants",
]);

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Deep-merge `saved` config on top of `defaults`, filling in any missing
// scalars from defaults so a sparse saved config (e.g. only
// `poi_selection.type_quotas`) still hydrates with all of DEFAULT_CONFIG's
// nested fields. Arrays from `saved` replace wholly; paths in
// REPLACE_WHOLLY_PATHS replace wholly; explicit `null` in saved is kept.
//
// IMPORTANT: This function is used at HYDRATE time only (loading from DB
// into editor state). Saving must use `computeSparseDelta` so we don't
// bloat the JSONB with every default value (mig 225 line 70: "Sparse
// JSONB — only non-default fields stored"; without sparse delta, person
// themes effectively erase org/system at every level).
const mergeWithDefaults = (defaults, saved, path = "") => {
  if (saved === undefined) {
    return defaults === undefined
      ? undefined
      : JSON.parse(JSON.stringify(defaults));
  }
  if (Array.isArray(saved) || Array.isArray(defaults)) {
    return JSON.parse(JSON.stringify(saved));
  }
  if (!isPlainObject(defaults) || !isPlainObject(saved)) {
    return saved;
  }
  if (REPLACE_WHOLLY_PATHS.has(path)) {
    return JSON.parse(JSON.stringify(saved));
  }
  const out = {};
  for (const k of Object.keys(defaults)) {
    out[k] = mergeWithDefaults(
      defaults[k],
      saved[k],
      path ? `${path}.${k}` : k,
    );
  }
  for (const k of Object.keys(saved)) {
    if (!(k in out)) out[k] = saved[k];
  }
  return out;
};

// Compute the SPARSE delta of `current` vs `defaults`. Only fields that
// differ from the default are emitted; everything else is omitted so the
// resolver continues to inherit from system / organisation. Arrays and
// REPLACE_WHOLLY_PATHS get whole-list comparison (only included if the
// JSON shapes differ). Used at SAVE time only — the inverse of
// mergeWithDefaults.
//
// Spec: mig 225 line 70 — "Sparse JSONB — only non-default fields
// stored". Effect: a person-level theme that only overrides
// boundary.line.color persists as `{ boundary: { line: { color: "..." } } }`,
// not a copy of every default. The resolver's deep-merge then
// continues inheriting every other field from org/system.
const computeSparseDelta = (defaults, current, path = "") => {
  // Treat both null and undefined symmetrically — if current matches
  // defaults (both nullish), drop it.
  if (current === undefined) return undefined;
  // Whole-replace paths and arrays compare via JSON equality.
  const isReplaceWholly =
    REPLACE_WHOLLY_PATHS.has(path) || Array.isArray(current) || Array.isArray(defaults);
  if (isReplaceWholly) {
    if (JSON.stringify(current) === JSON.stringify(defaults)) return undefined;
    return JSON.parse(JSON.stringify(current));
  }
  if (!isPlainObject(defaults) || !isPlainObject(current)) {
    if (current === defaults) return undefined;
    return current;
  }
  const out = {};
  const allKeys = new Set([...Object.keys(defaults), ...Object.keys(current)]);
  for (const k of allKeys) {
    const sub = computeSparseDelta(
      defaults[k],
      current[k],
      path ? `${path}.${k}` : k,
    );
    if (sub !== undefined) out[k] = sub;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
};

// Tighten 6/8-char only — server's HEX_RE rejects 3-char (#FFF). We
// previously accepted #FFF client-side which led to silent save failures
// with a generic toast. Standardise on 6 (#RRGGBB) or 8 (#RRGGBBAA) char
// hex client-side so the editor blocks before save.
const isHex = (v) => typeof v === "string" && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);

const countInvalidColors = (obj, path = "") => {
  if (obj == null || typeof obj !== "object") return 0;
  if (Array.isArray(obj)) {
    return obj.reduce((sum, v, i) => sum + countInvalidColors(v, `${path}[${i}]`), 0);
  }
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    const looksLikeColor =
      /color/i.test(k) || k === "fill" || k === "bg_color" || k === "stroke_color";
    if (looksLikeColor && typeof v === "string") {
      if (v && v !== "transparent" && !isHex(v)) n += 1;
    } else if (typeof v === "object" && v !== null) {
      n += countInvalidColors(v, `${path}.${k}`);
    }
  }
  return n;
};

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

function FieldRow({ label, hint, children, className, fieldKey }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 md:grid-cols-[180px_1fr] gap-2 md:gap-4 items-start py-1.5",
        className,
      )}
    >
      <div className="pt-1.5">
        <Label className="text-xs font-medium text-foreground inline-flex items-center">
          {label}
          <HelpTip fieldKey={fieldKey} />
        </Label>
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
          let n = Number(raw);
          if (!Number.isFinite(n)) return;
          // Soft clamp on commit (matches server-side validation expectations).
          if (typeof min === "number" && n < min) n = min;
          if (typeof max === "number" && n > max) n = max;
          onChange(n);
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

function SectionAccordion({ id, label, openId, onToggle, children, badge, onReset, canReset }) {
  const open = openId === id;
  return (
    <Collapsible open={open} onOpenChange={(next) => onToggle(next ? id : null)}>
      <div
        className={cn(
          "w-full flex items-center gap-1 px-1 rounded-md transition-colors",
          open ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex-1 flex items-center justify-between gap-2 px-2 py-2.5 text-left"
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
        {canReset && onReset && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
            title="Reset this section to FlexMedia defaults"
            className="h-6 w-6 text-muted-foreground hover:text-foreground shrink-0 mr-1"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        )}
      </div>
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1 space-y-1 border-l-2 border-muted ml-2 mt-0.5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Client-side mock previews (SVG) ────────────────────────────────────────
// Three distinct preview surfaces, each highlighting only the styling that
// affects it. They're not pixel-accurate vs the Modal renderer — they're
// guides so the operator can sanity-check colours / sizes / placement
// without burning a 0.5-2 s round-trip per slider tick.

// Shared SVG hex-fill helper (defends against bad colour values mid-edit).
function safeColor(v, fallback) {
  if (!v || v === "transparent") return fallback;
  return isHex(v) ? v : fallback;
}

// Synthetic terrain background (low-detail SVG pattern) — better than a blank
// frame for showing how the overlay reads against an aerial photo. We avoid
// loading an external JPG so the editor stays fast and works offline.
function NadirBackground() {
  return (
    <g aria-hidden>
      <defs>
        <pattern id="nadir-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <rect width="40" height="40" fill="#3a4a3f" />
          <path d="M0 20 H40 M20 0 V40" stroke="#2c3a31" strokeWidth="1" />
        </pattern>
        <pattern id="nadir-roof" x="180" y="100" width="120" height="80" patternUnits="userSpaceOnUse">
          <rect width="120" height="80" fill="#7a6e5a" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#nadir-grid)" />
      {/* a few "buildings" */}
      <rect x="180" y="100" width="120" height="80" fill="#7a6e5a" stroke="#574d3d" strokeWidth="1.5" />
      <rect x="60" y="40" width="60" height="50" fill="#6b5e4a" stroke="#3f3527" strokeWidth="1.5" />
      <rect x="350" y="190" width="50" height="60" fill="#807458" stroke="#574d3d" strokeWidth="1.5" />
      {/* "road" */}
      <rect x="0" y="220" width="500" height="14" fill="#444" />
    </g>
  );
}

function ObliqueBackground() {
  return (
    <g aria-hidden>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a3c8df" />
          <stop offset="60%" stopColor="#dceaf4" />
        </linearGradient>
        <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4a6048" />
          <stop offset="100%" stopColor="#2f3d2b" />
        </linearGradient>
      </defs>
      {/* sky */}
      <rect width="100%" height="120" fill="url(#sky)" />
      {/* ground (perspective) */}
      <polygon points="0,120 500,120 500,300 0,300" fill="url(#ground)" />
      {/* hero house in 3/4 perspective */}
      <polygon points="180,160 320,160 350,240 150,240" fill="#9a8a6e" stroke="#3f3527" strokeWidth="2" />
      <polygon points="180,160 250,110 320,160" fill="#7d6d52" stroke="#3f3527" strokeWidth="2" />
      <rect x="220" y="190" width="30" height="40" fill="#3a3025" />
      {/* neighbour buildings */}
      <rect x="40" y="180" width="80" height="60" fill="#7d7060" stroke="#3f3527" strokeWidth="1.5" />
      <rect x="380" y="190" width="80" height="60" fill="#867865" stroke="#3f3527" strokeWidth="1.5" />
    </g>
  );
}

// Generic POI label preview (used by both nadir/oblique mocks and the POI tab).
// Renders a single label box positioned at (cx, cy) with the user's poi_label
// style applied.
function PoiLabelMock({ cx, cy, text, secondary, cfg, scale = 1 }) {
  const fill = safeColor(cfg?.fill, "#FFFFFF");
  const textColor = safeColor(cfg?.text_color, "#000000");
  const padX = ((cfg?.padding_px?.left ?? 24) + (cfg?.padding_px?.right ?? 24)) / 2;
  const padY = ((cfg?.padding_px?.top ?? 12) + (cfg?.padding_px?.bottom ?? 12)) / 2;
  const fs = (cfg?.font_size_px ?? 36) * scale;
  // Approx text width — 0.55em per char is a safe middle-ground.
  const txtCase = cfg?.text_case ?? "uppercase";
  const display =
    txtCase === "uppercase" ? text.toUpperCase()
      : txtCase === "titlecase" ? text.replace(/\b\w/g, (c) => c.toUpperCase())
      : text;
  const w = display.length * fs * 0.55 + padX * 2 * scale;
  const h = fs * 1.15 + padY * 2 * scale;
  const cornerRadius =
    cfg?.shape === "pill" ? h / 2
      : cfg?.shape === "rounded_rectangle" ? Math.min(12, (cfg?.corner_radius_px ?? 0) * scale)
      : (cfg?.corner_radius_px ?? 0) * scale;
  const borderColor = cfg?.border?.color;
  const borderWidth = (cfg?.border?.width_px ?? 0) * scale;
  return (
    <g>
      <rect
        x={cx - w / 2}
        y={cy - h / 2}
        width={w}
        height={h}
        rx={cornerRadius}
        ry={cornerRadius}
        fill={fill === "transparent" ? "none" : fill}
        stroke={borderColor && isHex(borderColor) ? borderColor : "none"}
        strokeWidth={borderWidth}
      />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={textColor}
        fontFamily={cfg?.font_family || "DejaVu Sans, sans-serif"}
        fontSize={fs}
      >
        {display}
      </text>
      {secondary && cfg?.secondary_text?.enabled && (
        <text
          x={cx}
          y={cy + h / 2 + fs * 0.6}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={safeColor(cfg?.secondary_text?.color, "#666666")}
          fontFamily={cfg?.font_family || "DejaVu Sans, sans-serif"}
          fontSize={fs * 0.6}
        >
          {secondary}
        </text>
      )}
    </g>
  );
}

// Anchor-line (POI → label connector) mock.
function AnchorLineMock({ x1, y1, x2, y2, cfg, scale = 1 }) {
  const color = safeColor(cfg?.color, "#FFFFFF");
  const opacity = typeof cfg?.opacity === "number" ? cfg.opacity : 1;
  const width = (cfg?.width_px ?? 3) * scale;
  const dashArray =
    cfg?.shape === "dashed" ? `${8 * scale} ${6 * scale}` : "none";
  const marker = cfg?.end_marker;
  return (
    <g opacity={opacity}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dashArray}
        strokeLinecap="round"
      />
      {marker?.shape && marker.shape !== "none" && marker.size_px > 0 && (() => {
        const ms = marker.size_px * scale;
        const mfill = safeColor(marker.fill_color, color);
        const mstroke = safeColor(marker.stroke_color, color);
        const msw = marker.stroke_width_px ?? 0;
        if (marker.shape === "dot" || marker.shape === "circle")
          return <circle cx={x1} cy={y1} r={ms / 2} fill={mfill} stroke={mstroke} strokeWidth={msw} />;
        if (marker.shape === "diamond")
          return (
            <polygon
              points={`${x1},${y1 - ms / 2} ${x1 + ms / 2},${y1} ${x1},${y1 + ms / 2} ${x1 - ms / 2},${y1}`}
              fill={mfill}
              stroke={mstroke}
              strokeWidth={msw}
            />
          );
        if (marker.shape === "cross")
          return (
            <g stroke={mstroke || mfill} strokeWidth={Math.max(2, msw)} strokeLinecap="round">
              <line x1={x1 - ms / 2} y1={y1 - ms / 2} x2={x1 + ms / 2} y2={y1 + ms / 2} />
              <line x1={x1 - ms / 2} y1={y1 + ms / 2} x2={x1 + ms / 2} y2={y1 - ms / 2} />
            </g>
          );
        return null;
      })()}
    </g>
  );
}

// Property-pin mock (drawn for nadir + oblique).
function PropertyPinMock({ cx, cy, cfg, scale = 1 }) {
  if (cfg?.enabled === false) return null;
  const size = (cfg?.size_px ?? 120) * scale * 0.5; // half-scale for preview density
  const fill = safeColor(cfg?.fill_color, "#FFFFFF");
  const stroke = safeColor(cfg?.stroke_color, "#000000");
  const sw = (cfg?.stroke_width_px ?? 3) * scale;
  const mode = cfg?.mode || "teardrop_with_icon";
  const isLineUp = mode === "line_up_with_house_icon";
  const isPill = mode === "pill_with_address";

  if (isPill) {
    const w = size * 1.6;
    const h = size * 0.6;
    return (
      <g>
        <rect
          x={cx - w / 2}
          y={cy - h / 2}
          width={w}
          height={h}
          rx={h / 2}
          ry={h / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
        />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fill={safeColor(cfg?.content?.text_color, "#000000")} fontSize={h * 0.45}>
          PIN
        </text>
      </g>
    );
  }

  if (isLineUp) {
    return (
      <g>
        <line x1={cx} y1={cy + size} x2={cx} y2={cy} stroke={stroke} strokeWidth={sw} />
        <circle cx={cx} cy={cy} r={size * 0.3} fill={fill} stroke={stroke} strokeWidth={sw} />
        <path
          d={`M ${cx - size * 0.15} ${cy + size * 0.05} L ${cx} ${cy - size * 0.15} L ${cx + size * 0.15} ${cy + size * 0.05} Z`}
          fill={safeColor(cfg?.content?.icon_color, "#000000")}
        />
      </g>
    );
  }

  // teardrop_*
  return (
    <g>
      <path
        d={`M ${cx} ${cy + size * 0.5} C ${cx - size * 0.55} ${cy + size * 0.1}, ${cx - size * 0.55} ${cy - size * 0.5}, ${cx} ${cy - size * 0.5} C ${cx + size * 0.55} ${cy - size * 0.5}, ${cx + size * 0.55} ${cy + size * 0.1}, ${cx} ${cy + size * 0.5} Z`}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
      />
      {cfg?.content?.type === "icon" && (
        <path
          d={`M ${cx - size * 0.2} ${cy + size * 0.05} L ${cx} ${cy - size * 0.2} L ${cx + size * 0.2} ${cy + size * 0.05} L ${cx + size * 0.2} ${cy + size * 0.2} L ${cx - size * 0.2} ${cy + size * 0.2} Z`}
          fill={safeColor(cfg?.content?.icon_color, "#000000")}
        />
      )}
      {cfg?.content?.type === "monogram" && (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.45} fill={safeColor(cfg?.content?.text_color, "#000000")}>
          {(cfg?.content?.monogram || "AB").slice(0, 2)}
        </text>
      )}
      {cfg?.content?.type === "text" && (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.3} fill={safeColor(cfg?.content?.text_color, "#000000")}>
          {(cfg?.content?.text || "TXT").slice(0, 4)}
        </text>
      )}
    </g>
  );
}

function BoundaryMock({ points, cfg, scale = 1 }) {
  if (!cfg?.enabled) return null;
  const color = safeColor(cfg?.line?.color, "#FFFFFF");
  const width = (cfg?.line?.width_px ?? 6) * scale * 0.5;
  const dash =
    cfg?.line?.style === "dashed" ? `${10 * scale} ${6 * scale}`
      : cfg?.line?.style === "dotted" ? `${2 * scale} ${4 * scale}`
      : "none";
  return (
    <polygon
      points={points.map((p) => p.join(",")).join(" ")}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeDasharray={dash}
      strokeLinejoin="round"
    />
  );
}

function BrandingRibbonMock({ cfg, width, height }) {
  if (!cfg?.enabled) return null;
  const h = Math.min((cfg?.height_px ?? 80) * 0.3, height * 0.18);
  const y = cfg?.position === "top" ? 0 : height - h;
  const bg = safeColor(cfg?.bg_color, "#000000");
  const fg = safeColor(cfg?.text_color, "#FFFFFF");
  return (
    <g>
      <rect x={0} y={y} width={width} height={h} fill={bg} opacity={0.92} />
      {cfg?.show_address !== false && (
        <text
          x={width / 2}
          y={y + h / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={fg}
          fontSize={Math.max(10, h * 0.5)}
        >
          9 Chauvel Ave, Wattle Grove
        </text>
      )}
    </g>
  );
}

function NadirPreview({ config }) {
  const w = 500, h = 300;
  // Property pin near centre, with 3 POIs and anchor lines around it.
  const pin = { x: 250, y: 150 };
  const pois = [
    { x: 90, y: 60, lx: 60, ly: 35, name: "Wattle Grove Park", dist: "220 m" },
    { x: 410, y: 80, lx: 440, ly: 50, name: "Wattle Grove Public School", dist: "280 m" },
    { x: 380, y: 240, lx: 410, ly: 270, name: "Wattle Grove Shops", dist: "350 m" },
  ];
  // Boundary as a small rectangle around the pin (in image coords).
  const boundaryPts = [
    [220, 130], [280, 130], [280, 170], [220, 170],
  ];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block bg-black">
      <NadirBackground />
      <BoundaryMock points={boundaryPts} cfg={config?.boundary} scale={1} />
      <PropertyPinMock cx={pin.x} cy={pin.y} cfg={config?.property_pin} scale={1} />
      {pois.map((p, i) => (
        <g key={i}>
          <AnchorLineMock x1={p.x} y1={p.y} x2={p.lx} y2={p.ly} cfg={config?.anchor_line} scale={0.5} />
          <circle cx={p.x} cy={p.y} r={4} fill="#fff" />
          <PoiLabelMock cx={p.lx} cy={p.ly} text={p.name} secondary={p.dist} cfg={config?.poi_label} scale={0.35} />
        </g>
      ))}
      <BrandingRibbonMock cfg={config?.branding_ribbon} width={w} height={h} />
    </svg>
  );
}

function ObliquePreview({ config }) {
  const w = 500, h = 300;
  const pin = { x: 250, y: 200 };
  const pois = [
    { x: 80, y: 220, lx: 70, ly: 175, name: "Park", dist: "220 m" },
    { x: 420, y: 230, lx: 430, ly: 175, name: "School", dist: "280 m" },
  ];
  // Boundary perspective polygon around the hero house base.
  const boundaryPts = [
    [180, 230], [320, 230], [340, 250], [160, 250],
  ];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block bg-black">
      <ObliqueBackground />
      <BoundaryMock points={boundaryPts} cfg={config?.boundary} scale={1} />
      <PropertyPinMock cx={pin.x} cy={pin.y - 60} cfg={config?.property_pin} scale={1} />
      {pois.map((p, i) => (
        <g key={i}>
          <AnchorLineMock x1={p.x} y1={p.y} x2={p.lx} y2={p.ly} cfg={config?.anchor_line} scale={0.5} />
          <circle cx={p.x} cy={p.y} r={4} fill="#fff" />
          <PoiLabelMock cx={p.lx} cy={p.ly} text={p.name} secondary={p.dist} cfg={config?.poi_label} scale={0.35} />
        </g>
      ))}
      <BrandingRibbonMock cfg={config?.branding_ribbon} width={w} height={h} />
    </svg>
  );
}

function PoiCloseupPreview({ config }) {
  const w = 500, h = 300;
  // Show a single POI label + anchor line at large scale, plain background.
  const poi = { x: 130, y: 220 };
  const label = { x: 320, y: 110 };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block">
      <rect width={w} height={h} fill="#1f2933" />
      {/* faint grid for measurement reference */}
      <g opacity={0.08} stroke="#fff">
        {Array.from({ length: 10 }).map((_, i) => (
          <line key={`v${i}`} x1={i * 50} y1={0} x2={i * 50} y2={h} />
        ))}
        {Array.from({ length: 6 }).map((_, i) => (
          <line key={`h${i}`} x1={0} y1={i * 50} x2={w} y2={i * 50} />
        ))}
      </g>
      <AnchorLineMock x1={poi.x} y1={poi.y} x2={label.x} y2={label.y} cfg={config?.anchor_line} scale={1} />
      <circle cx={poi.x} cy={poi.y} r={8} fill="#fff" stroke="#000" strokeWidth={2} />
      <PoiLabelMock cx={label.x} cy={label.y} text="Wattle Grove Public School" secondary="280 m" cfg={config?.poi_label} scale={0.6} />
    </svg>
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
  const [versionInt, setVersionInt] = useState(null);
  const [status, setStatus] = useState("active");
  const [openSection, setOpenSection] = useState("poi_selection");
  const [openGroup, setOpenGroup] = useState("poi"); // which sidebar group is expanded
  const [previewTab, setPreviewTab] = useState("nadir");
  const [loading, setLoading] = useState(!!themeId);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);
  // Snapshot of the hydrated state (name + config + is_default) used to
  // detect unsaved changes when Cancel is clicked. (Bug #12)
  const baselineRef = useRef({ name: "", config: DEFAULT_CONFIG, isDefault: false });

  // Save-confirmation dialog state (only fires when versionInt > 1).
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveAsNewPending, setSaveAsNewPending] = useState(false);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactRows, setImpactRows] = useState([]); // [{ project_id, project_address, shoot_id, shoot_status, renders_count, in_flight, is_truncated }]
  // QC6 #25: drone_theme_impacted_projects() caps the impact list at 200
  // rows. Until migration 273 the function gave no signal that the cap had
  // been hit, so the operator could believe the impact was contained. This
  // ref captures the new is_truncated flag from any row and surfaces a
  // warning under the visible list. Boolean is sticky per fetch — if any
  // row reports truncation we show the banner regardless of in_flight
  // filtering (since the truncation happened *before* the filter).
  const [impactTruncated, setImpactTruncated] = useState(false);
  const [impactRpcAvailable, setImpactRpcAvailable] = useState(true);
  const [autoRerender, setAutoRerender] = useState(false);
  const [rerendering, setRerendering] = useState(false);

  const invalidColorCount = useMemo(() => countInvalidColors(config), [config]);

  // ── Live preview state (right column) — kept for the slow server preview ─
  const [previewImg, setPreviewImg] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const previewSeqRef = useRef(0);

  // ── Hydrate ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      if (initialTheme) {
        const hydratedName = initialTheme.name || "";
        const hydratedConfig = mergeWithDefaults(DEFAULT_CONFIG, initialTheme.config || {});
        const hydratedIsDefault = !!initialTheme.is_default;
        setName(hydratedName);
        setConfig(hydratedConfig);
        setIsDefault(hydratedIsDefault);
        setVersion(initialTheme.version || null);
        setVersionInt(initialTheme.version_int ?? null);
        setStatus(initialTheme.status || "active");
        baselineRef.current = {
          name: hydratedName,
          config: hydratedConfig,
          isDefault: hydratedIsDefault,
        };
        return;
      }
      if (!themeId) {
        // New theme — baseline is the empty starting state.
        baselineRef.current = {
          name: "",
          config: DEFAULT_CONFIG,
          isDefault: false,
        };
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const row = await api.entities.DroneTheme.get(themeId);
        if (cancelled) return;
        const hydratedName = row.name || "";
        const hydratedConfig = mergeWithDefaults(DEFAULT_CONFIG, row.config || {});
        const hydratedIsDefault = !!row.is_default;
        setName(hydratedName);
        setConfig(hydratedConfig);
        setIsDefault(hydratedIsDefault);
        setVersion(row.version || null);
        setVersionInt(row.version_int ?? null);
        setStatus(row.status || "active");
        baselineRef.current = {
          name: hydratedName,
          config: hydratedConfig,
          isDefault: hydratedIsDefault,
        };
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

  // Bug #12 — guarded Cancel: prompt before discarding unsaved edits. We
  // compare the current state to the baseline snapshot taken at hydrate.
  // JSON.stringify is deep-equality enough for this config tree (no
  // functions, no Maps, no Dates).
  const hasUnsavedChanges = useCallback(() => {
    const b = baselineRef.current;
    if (b.name !== name) return true;
    if (b.isDefault !== isDefault) return true;
    return JSON.stringify(b.config) !== JSON.stringify(config);
  }, [name, config, isDefault]);

  const handleCancelClick = useCallback(() => {
    if (
      hasUnsavedChanges() &&
      typeof window !== "undefined" &&
      !window.confirm("Discard unsaved theme changes?")
    ) {
      return;
    }
    onCancel?.();
  }, [hasUnsavedChanges, onCancel]);

  const update = useCallback((path, value) => {
    setConfig((prev) => setDeep(prev, path, value));
  }, []);

  // ── Impact-list fetch (Subagent A's drone_theme_impacted_projects RPC) ──
  // Called inside the save dialog when versionInt > 1. If the RPC isn't
  // available (e.g. migration hasn't been applied in this env) we degrade
  // gracefully — the dialog still opens, the impact section shows a
  // "couldn't load" tooltip, and Save proceeds without the auto-rerender opt.
  const fetchImpactList = useCallback(async (tid) => {
    if (!tid) {
      setImpactRows([]);
      setImpactTruncated(false);
      return;
    }
    setImpactLoading(true);
    try {
      const rows = await api.rpc("drone_theme_impacted_projects", { p_theme_id: tid });
      const arr = Array.isArray(rows) ? rows : [];
      setImpactRows(arr.filter((r) => r.in_flight === true));
      // QC6 #25: any row stamped is_truncated=true means the underlying
      // 200-row cap was hit. Pre-migration 273 servers won't include the
      // column at all → fall back to false (no banner shown).
      setImpactTruncated(arr.some((r) => r?.is_truncated === true));
      setImpactRpcAvailable(true);
    } catch (e) {
      // If the RPC doesn't exist (404 / function not found), disable the impact
      // list with a tooltip and let Save proceed without the re-render opt.
      console.warn("[ThemeEditor] drone_theme_impacted_projects unavailable:", e?.message);
      setImpactRpcAvailable(false);
      setImpactRows([]);
      setImpactTruncated(false);
    } finally {
      setImpactLoading(false);
    }
  }, []);

  // ── Save handlers ────────────────────────────────────────────────────────
  // Direct save — used for new themes (versionInt null/1) or when the user
  // confirms via the dialog. Returns the server response so callers can
  // chain re-renders against the new theme version.
  const performSave = useCallback(
    async ({ saveAsNew = false }) => {
      if (!name?.trim()) {
        toast.error("Theme name is required");
        return null;
      }
      if (!canEdit) {
        toast.error("You don't have permission to save this theme");
        return null;
      }
      if (invalidColorCount > 0) {
        toast.error(
          `Fix ${invalidColorCount} invalid colour value${invalidColorCount === 1 ? "" : "s"} before saving`,
        );
        return null;
      }
      setSaving(true);
      try {
        // Sparse-delta save: only persist fields that differ from
        // DEFAULT_CONFIG so the resolver still inherits everything else
        // from org/system. Without this, person themes would override
        // every default value at every level, defeating the point of
        // inheritance. (Bug #1 — sparse-merge inversion)
        const sparseConfig = computeSparseDelta(DEFAULT_CONFIG, config) || {};
        // Always echo theme_name into the saved config so DB readers
        // (RPCs, audit) can identify the theme without joining.
        sparseConfig.theme_name = name.trim();
        const payload = {
          owner_kind: ownerKind,
          owner_id: ownerId,
          name: name.trim(),
          config: sparseConfig,
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
        // Mirror server state locally (so the version badge updates without a
        // round-trip and a follow-up Save doesn't reuse a stale version).
        if (typeof data.version === "number") setVersion(data.version);
        // Use the authoritative version_int from the server when echoed —
        // otherwise bump optimistically. Parent will refetch on close.
        if (typeof data.version_int === "number") {
          setVersionInt(data.version_int);
        } else {
          setVersionInt((v) => (v == null ? 1 : v + 1));
        }
        toast.success(saveAsNew ? "Theme created" : "Theme saved");
        return {
          theme_id: data.theme_id,
          version: data.version,
          name: name.trim(),
          is_default: isDefault,
        };
      } catch (e) {
        toast.error(e?.message || "Failed to save theme");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [name, config, isDefault, themeId, ownerKind, ownerId, canEdit, invalidColorCount],
  );

  // Fan out drone-render with wipe_existing for each impacted shoot.
  // Bug #13 — previously serial-awaited each invoke, so a 50-shoot save
  // sat in `for await` for several minutes. Cap concurrency to 5 (chunk
  // + Promise.allSettled) so a typical fan-out completes in seconds.
  const reRenderImpactedShoots = useCallback(async () => {
    if (impactRows.length === 0) return { ok: 0, failed: 0 };
    setRerendering(true);
    let ok = 0;
    let failed = 0;
    // Deduplicate shoot_ids first — multiple rows per shoot if there are
    // many renders, but we only need one drone-render call per shoot.
    const shootIds = Array.from(new Set(impactRows.map((r) => r.shoot_id).filter(Boolean)));
    const CONCURRENCY = 5;
    for (let i = 0; i < shootIds.length; i += CONCURRENCY) {
      const chunk = shootIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((sid) =>
          api.functions.invoke("drone-render", {
            shoot_id: sid,
            wipe_existing: true,
          }),
        ),
      );
      for (let j = 0; j < results.length; j++) {
        const res = results[j];
        if (res.status === "fulfilled" && res.value?.data?.success !== false) {
          ok += 1;
        } else {
          if (res.status === "rejected") {
            console.warn("[ThemeEditor] re-render failed for shoot", chunk[j], res.reason?.message);
          }
          failed += 1;
        }
      }
    }
    setRerendering(false);
    return { ok, failed };
  }, [impactRows]);

  // Save click handler — branches into the confirmation dialog when
  // versionInt > 1 (the theme has been saved before) and is_default. For new
  // themes / first-save we skip the dialog: there can't be impacted renders
  // yet because no render has stamped this theme version.
  const onClickSave = useCallback(
    async ({ saveAsNew }) => {
      // saveAsNew always creates a fresh row; skip dialog (no prior renders).
      if (saveAsNew) {
        const saved = await performSave({ saveAsNew: true });
        if (saved) onSaved?.(saved);
        return;
      }
      // First save (or unknown version_int) — no impact possible.
      if (!themeId || (versionInt ?? 1) <= 1) {
        const saved = await performSave({ saveAsNew: false });
        if (saved) onSaved?.(saved);
        return;
      }
      // Existing theme, version > 1 — open dialog and fetch impact list.
      setSaveAsNewPending(false);
      setAutoRerender(false);
      setSaveDialogOpen(true);
      fetchImpactList(themeId);
    },
    [themeId, versionInt, performSave, onSaved, fetchImpactList],
  );

  const onConfirmSaveFromDialog = useCallback(
    async ({ withRerender }) => {
      const saved = await performSave({ saveAsNew: saveAsNewPending });
      if (!saved) {
        // Save failed — keep dialog open so the operator can retry without
        // losing the impact context.
        return;
      }
      if (withRerender && impactRows.length > 0) {
        const { ok, failed } = await reRenderImpactedShoots();
        if (failed > 0) {
          toast.error(`Re-rendered ${ok}/${ok + failed} shoots — ${failed} failed`);
        } else if (ok > 0) {
          toast.success(`Queued re-render for ${ok} shoot${ok === 1 ? "" : "s"}`);
        }
      }
      setSaveDialogOpen(false);
      onSaved?.(saved);
    },
    [performSave, saveAsNewPending, impactRows.length, reRenderImpactedShoots, onSaved],
  );

  const resetToDefaults = useCallback(() => {
    if (!canEdit) return;
    if (typeof window !== "undefined" && !window.confirm(
      "Reset every field back to FlexMedia defaults? This won't be saved until you click Save.",
    )) return;
    setConfig({ ...DEFAULT_CONFIG });
    toast.info("Reset to FlexMedia defaults — click Save to persist.");
  }, [canEdit]);

  const resetSection = useCallback(
    (sectionKey) => {
      if (!canEdit) return;
      const def = DEFAULT_CONFIG[sectionKey];
      if (def === undefined) return;
      if (typeof window !== "undefined" && !window.confirm(
        `Reset "${sectionKey}" to FlexMedia defaults? Other sections won't change.`,
      )) return;
      setConfig((prev) => ({ ...prev, [sectionKey]: JSON.parse(JSON.stringify(def)) }));
    },
    [canEdit],
  );

  // ── Slow / accurate server preview (kept as opt-in button) ──────────────
  const fetchPreview = useCallback(async (cfg) => {
    const mySeq = ++previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await api.functions.invoke("drone-render-preview", {
        theme_config: { ...cfg, theme_name: cfg?.theme_name || "preview" },
      });
      if (mySeq !== previewSeqRef.current) return;
      const data = result?.data;
      if (!data?.success || !data?.image_b64) {
        throw new Error(data?.error || "Preview render failed");
      }
      setPreviewImg(`data:image/jpeg;base64,${data.image_b64}`);
    } catch (e) {
      if (mySeq !== previewSeqRef.current) return;
      setPreviewError(e?.message || "Preview render failed");
    } finally {
      if (mySeq === previewSeqRef.current) {
        setPreviewLoading(false);
      }
    }
  }, []);

  const debouncedFetchPreview = useMemo(
    () => debounce((cfg) => fetchPreview(cfg), 800),
    [fetchPreview],
  );
  useEffect(() => () => debouncedFetchPreview.cancel(), [debouncedFetchPreview]);

  const triggerServerPreview = useCallback(() => {
    debouncedFetchPreview.cancel();
    fetchPreview(config);
  }, [config, debouncedFetchPreview, fetchPreview]);

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
  // Type-quotas drive which Google Places categories drone-pois actually
  // queries (and how many of each surface in the curated result). Keys are
  // canonical Google Places enum values; the legacy 'shopping' / 'train'
  // aliases are normalised at the drone-pois layer for back-compat with
  // older themes saved before migration 246.
  //
  // The UI is a fixed checklist of the supported categories: ticking a row
  // adds the key to type_quotas with that row's defaults; un-ticking it
  // removes the key entirely (so drone-pois treats the type as opted-out).
  const quotas = config.poi_selection?.type_quotas || {};
  const togglePoiType = (typeValue, defaults) => {
    if (typeValue in quotas) {
      // Remove the key entirely — opt-out.
      const { [typeValue]: _, ...rest } = quotas;
      update(["poi_selection", "type_quotas"], rest);
    } else {
      // Re-add with the row's defaults.
      update(["poi_selection", "type_quotas", typeValue], {
        priority: defaults.defaultPriority,
        max: defaults.defaultMax,
      });
    }
  };
  const updatePoiTypeField = (typeValue, field, value) => {
    update(["poi_selection", "type_quotas", typeValue, field], value);
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

  // Render the section panel for a given id. Encapsulated so both groups
  // (poi / render) can render any section without code duplication.
  function renderSection(id) {
    switch (id) {
      case "poi_selection":
        return (
          <SectionAccordion
            id="poi_selection"
            label="POI selection (which POIs to fetch)"
            openId={openSection}
            onToggle={setOpenSection}
            canReset={canEdit}
            onReset={() => resetSection("poi_selection")}
          >
            <FieldRow label="Radius" hint="metres" fieldKey="poi_selection.radius_m">
              <NumberField
                value={config.poi_selection?.radius_m}
                onChange={(v) => update(["poi_selection", "radius_m"], v)}
                min={50}
                max={5000}
                suffix="m"
              />
            </FieldRow>
            <FieldRow label="Max pins per shot" fieldKey="poi_selection.max_pins_per_shot">
              <NumberField
                value={config.poi_selection?.max_pins_per_shot}
                onChange={(v) => update(["poi_selection", "max_pins_per_shot"], v)}
                min={0}
                max={20}
              />
            </FieldRow>
            <FieldRow label="Min separation" fieldKey="poi_selection.min_separation_px">
              <NumberField
                value={config.poi_selection?.min_separation_px}
                onChange={(v) => update(["poi_selection", "min_separation_px"], v)}
                min={0}
                max={2000}
                suffix="px"
              />
            </FieldRow>
            <FieldRow label="Curation" fieldKey="poi_selection.curation">
              <SelectField
                value={config.poi_selection?.curation}
                onChange={(v) => update(["poi_selection", "curation"], v)}
                options={["auto", "manual_only"]}
              />
            </FieldRow>

            <div className="mt-3 pt-2 border-t border-dashed border-muted">
              <div className="flex items-center gap-1 mb-2">
                <p className="text-xs font-semibold text-muted-foreground">
                  Type quotas
                </p>
                <HelpTip fieldKey="poi_selection.type_quotas" />
              </div>
              <p className="text-[10px] text-muted-foreground mb-2">
                Tick categories to include. Per-type Max caps how many of that
                category can appear; Priority decides which types fill the
                global Max-pins-per-shot budget first.
              </p>
              <div className="grid grid-cols-[24px_1fr_72px_72px] gap-2 items-center mb-1">
                <span />
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Category</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground text-center">Max</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground text-center">Prio</span>
              </div>
              <div className="space-y-1">
                {POI_TYPE_OPTIONS.map((opt) => {
                  const enabled = opt.value in quotas;
                  const q = quotas[opt.value] || {};
                  return (
                    <PoiTypeChecklistRow
                      key={opt.value}
                      option={opt}
                      enabled={enabled}
                      max={q.max ?? opt.defaultMax}
                      priority={q.priority ?? opt.defaultPriority}
                      onToggle={() => togglePoiType(opt.value, opt)}
                      onChangeMax={(v) => updatePoiTypeField(opt.value, "max", v)}
                      onChangePriority={(v) => updatePoiTypeField(opt.value, "priority", v)}
                      disabled={!canEdit}
                    />
                  );
                })}
              </div>
            </div>
          </SectionAccordion>
        );

      case "anchor_line":
        return (
          <SectionAccordion
            id="anchor_line"
            label="Anchor line (POI → label connector)"
            openId={openSection}
            onToggle={setOpenSection}
            canReset={canEdit}
            onReset={() => resetSection("anchor_line")}
          >
            <FieldRow label="Shape" fieldKey="anchor_line.shape">
              <SelectField
                value={config.anchor_line?.shape}
                onChange={(v) => update(["anchor_line", "shape"], v)}
                options={["thin", "thick_bar", "dashed"]}
              />
            </FieldRow>
            <FieldRow label="Width" hint="pixels" fieldKey="anchor_line.width_px">
              <NumberField
                value={config.anchor_line?.width_px}
                onChange={(v) => update(["anchor_line", "width_px"], v)}
                min={1}
                max={50}
                suffix="px"
              />
            </FieldRow>
            <FieldRow label="Color" fieldKey="anchor_line.color">
              <ColorField
                value={config.anchor_line?.color}
                onChange={(v) => update(["anchor_line", "color"], v)}
              />
            </FieldRow>
            <FieldRow label="Opacity" hint="0.0 – 1.0" fieldKey="anchor_line.opacity">
              <NumberField
                value={config.anchor_line?.opacity}
                onChange={(v) => update(["anchor_line", "opacity"], v)}
                min={0}
                max={1}
                step={0.05}
              />
            </FieldRow>
            {/* Bug #5 — length budget fields were in DEFAULT_CONFIG but
                never wired to UI. Help dictionary already has tooltips. */}
            <FieldRow label="Min length" fieldKey="anchor_line.min_length_px">
              <NumberField
                value={config.anchor_line?.min_length_px}
                onChange={(v) => update(["anchor_line", "min_length_px"], v)}
                min={0}
                max={1000}
                suffix="px"
              />
            </FieldRow>
            <FieldRow label="Max length" fieldKey="anchor_line.max_length_px">
              <NumberField
                value={config.anchor_line?.max_length_px}
                onChange={(v) => update(["anchor_line", "max_length_px"], v)}
                min={0}
                max={2000}
                suffix="px"
              />
            </FieldRow>
            <FieldRow label="Flip-below threshold" fieldKey="anchor_line.flip_below_target_threshold_px">
              <NumberField
                value={config.anchor_line?.flip_below_target_threshold_px}
                onChange={(v) => update(["anchor_line", "flip_below_target_threshold_px"], v)}
                min={0}
                max={1000}
                suffix="px"
              />
            </FieldRow>

            <div className="mt-3 pt-2 border-t border-dashed border-muted">
              <p className="text-xs font-semibold text-muted-foreground mb-1">End marker</p>
              <FieldRow label="Shape" fieldKey="anchor_line.end_marker.shape">
                <SelectField
                  value={config.anchor_line?.end_marker?.shape}
                  onChange={(v) => update(["anchor_line", "end_marker", "shape"], v)}
                  options={["none", "dot", "diamond", "circle", "cross"]}
                />
              </FieldRow>
              <FieldRow label="Size" fieldKey="anchor_line.end_marker.size_px">
                <NumberField
                  value={config.anchor_line?.end_marker?.size_px}
                  onChange={(v) => update(["anchor_line", "end_marker", "size_px"], v)}
                  min={0}
                  max={100}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Fill color" fieldKey="anchor_line.end_marker.fill_color">
                <ColorField
                  value={config.anchor_line?.end_marker?.fill_color}
                  onChange={(v) => update(["anchor_line", "end_marker", "fill_color"], v)}
                />
              </FieldRow>
              <FieldRow label="Stroke color" fieldKey="anchor_line.end_marker.stroke_color">
                <ColorField
                  value={config.anchor_line?.end_marker?.stroke_color}
                  onChange={(v) => update(["anchor_line", "end_marker", "stroke_color"], v)}
                />
              </FieldRow>
              <FieldRow label="Stroke width" fieldKey="anchor_line.end_marker.stroke_width_px">
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
        );

      case "poi_label":
        return (
          <SectionAccordion
            id="poi_label"
            label="POI label (style)"
            openId={openSection}
            onToggle={setOpenSection}
            canReset={canEdit}
            onReset={() => resetSection("poi_label")}
            badge={config.poi_label?.enabled !== false ? "On" : "Off"}
          >
            {/* Master toggle (mig 239) — when off, NO POI labels render
                regardless of how many POIs are in the data. Mirrors the
                property_pin pattern. (Bug #2) */}
            <FieldRow label="Enabled" hint="Master switch — turn off to hide all POI labels" fieldKey="poi_label.enabled">
              <SwitchField
                value={config.poi_label?.enabled !== false}
                onChange={(v) => update(["poi_label", "enabled"], v)}
              />
            </FieldRow>
            <FieldRow label="Shape" fieldKey="poi_label.shape">
              <SelectField
                value={config.poi_label?.shape}
                onChange={(v) => update(["poi_label", "shape"], v)}
                options={["rectangle", "rounded_rectangle", "pill"]}
              />
            </FieldRow>
            <FieldRow label="Corner radius" fieldKey="poi_label.corner_radius_px">
              <NumberField
                value={config.poi_label?.corner_radius_px}
                onChange={(v) => update(["poi_label", "corner_radius_px"], v)}
                min={0}
                max={64}
                suffix="px"
              />
            </FieldRow>
            <FieldRow label="Fill" hint='hex or "transparent"' fieldKey="poi_label.fill">
              <ColorField
                value={config.poi_label?.fill}
                onChange={(v) => update(["poi_label", "fill"], v)}
              />
            </FieldRow>
            <FieldRow label="Text color" fieldKey="poi_label.text_color">
              <ColorField
                value={config.poi_label?.text_color}
                onChange={(v) => update(["poi_label", "text_color"], v)}
              />
            </FieldRow>
            <FieldRow label="Text case" fieldKey="poi_label.text_case">
              <SelectField
                value={config.poi_label?.text_case}
                onChange={(v) => update(["poi_label", "text_case"], v)}
                options={["asis", "uppercase", "titlecase"]}
              />
            </FieldRow>
            <FieldRow label="Font size" fieldKey="poi_label.font_size_px">
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
              <FieldRow label="Top" fieldKey="poi_label.padding_px.top">
                <NumberField
                  value={config.poi_label?.padding_px?.top}
                  onChange={(v) => update(["poi_label", "padding_px", "top"], v)}
                  min={0}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Right" fieldKey="poi_label.padding_px.right">
                <NumberField
                  value={config.poi_label?.padding_px?.right}
                  onChange={(v) => update(["poi_label", "padding_px", "right"], v)}
                  min={0}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Bottom" fieldKey="poi_label.padding_px.bottom">
                <NumberField
                  value={config.poi_label?.padding_px?.bottom}
                  onChange={(v) => update(["poi_label", "padding_px", "bottom"], v)}
                  min={0}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="Left" fieldKey="poi_label.padding_px.left">
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
              <FieldRow label="Color" fieldKey="poi_label.border.color">
                <ColorField
                  value={config.poi_label?.border?.color}
                  onChange={(v) => update(["poi_label", "border", "color"], v)}
                  allowNull
                />
              </FieldRow>
              <FieldRow label="Width" fieldKey="poi_label.border.width_px">
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
              <FieldRow label="Enabled" fieldKey="poi_label.secondary_text.enabled">
                <SwitchField
                  value={config.poi_label?.secondary_text?.enabled}
                  onChange={(v) => update(["poi_label", "secondary_text", "enabled"], v)}
                />
              </FieldRow>
              {config.poi_label?.secondary_text?.enabled && (
                <>
                  <FieldRow label="Template" fieldKey="poi_label.secondary_text.template">
                    <TextField
                      value={config.poi_label?.secondary_text?.template}
                      onChange={(v) =>
                        update(["poi_label", "secondary_text", "template"], v)
                      }
                      placeholder="{distance}"
                      mono
                    />
                  </FieldRow>
                  <FieldRow label="Color" fieldKey="poi_label.secondary_text.color">
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
        );

      case "poi_label_foreground":
        // Advanced text-rendering knobs for the standard boxed POI label
        // (font family, line height, letter spacing, primary template).
        // Bound to `poi_label.*` keys — NOT `poi_label_foreground.*`,
        // despite the section id. Renamed from "foreground" → "typography"
        // because foreground (outlined-text) styling is Wave 3 (the
        // poi_label_foreground.* schema keys aren't surfaced anywhere yet).
        return (
          <SectionAccordion
            id="poi_label_foreground"
            label="POI label typography (advanced)"
            openId={openSection}
            onToggle={setOpenSection}
            canReset={canEdit}
            onReset={() => resetSection("poi_label")}
          >
            <FieldRow label="Font family" hint="must exist on render server" fieldKey="poi_label.font_family">
              <TextField
                value={config.poi_label?.font_family}
                onChange={(v) => update(["poi_label", "font_family"], v)}
                placeholder="DejaVu Sans"
                mono
              />
            </FieldRow>
            <FieldRow label="Letter spacing" hint="em units" fieldKey="poi_label.letter_spacing">
              <NumberField
                value={config.poi_label?.letter_spacing}
                onChange={(v) => update(["poi_label", "letter_spacing"], v)}
                min={-2}
                max={5}
                step={0.05}
              />
            </FieldRow>
            <FieldRow label="Line height" hint="multiplier" fieldKey="poi_label.line_height">
              <NumberField
                value={config.poi_label?.line_height}
                onChange={(v) => update(["poi_label", "line_height"], v)}
                min={0.8}
                max={3}
                step={0.05}
              />
            </FieldRow>
            <FieldRow label="Primary template" hint="e.g. {name}" fieldKey="poi_label.text_template">
              <TextField
                value={config.poi_label?.text_template}
                onChange={(v) => update(["poi_label", "text_template"], v)}
                placeholder="{name}"
                mono
              />
            </FieldRow>
          </SectionAccordion>
        );

      case "property_pin":
        return (
          <SectionAccordion
            id="property_pin"
            label="Property pin"
            openId={openSection}
            onToggle={setOpenSection}
            canReset={canEdit}
            onReset={() => resetSection("property_pin")}
            badge={config.property_pin?.enabled !== false ? "On" : "Off"}
          >
            <FieldRow label="Enabled" hint="Master switch — turn off to hide the property pin" fieldKey="property_pin.enabled">
              <SwitchField
                value={config.property_pin?.enabled !== false}
                onChange={(v) => update(["property_pin", "enabled"], v)}
              />
            </FieldRow>
            {config.property_pin?.enabled !== false && (
              <>
                <FieldRow label="Mode" fieldKey="property_pin.mode">
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
                <FieldRow label="Size" fieldKey="property_pin.size_px">
                  <NumberField
                    value={config.property_pin?.size_px}
                    onChange={(v) => update(["property_pin", "size_px"], v)}
                    min={20}
                    max={400}
                    suffix="px"
                  />
                </FieldRow>
                <FieldRow label="Fill color" fieldKey="property_pin.fill_color">
                  <ColorField
                    value={config.property_pin?.fill_color}
                    onChange={(v) => update(["property_pin", "fill_color"], v)}
                  />
                </FieldRow>
                <FieldRow label="Stroke color" fieldKey="property_pin.stroke_color">
                  <ColorField
                    value={config.property_pin?.stroke_color}
                    onChange={(v) => update(["property_pin", "stroke_color"], v)}
                  />
                </FieldRow>
                <FieldRow label="Stroke width" fieldKey="property_pin.stroke_width_px">
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
                  <FieldRow label="Type" fieldKey="property_pin.content.type">
                    <SelectField
                      value={config.property_pin?.content?.type}
                      onChange={(v) => update(["property_pin", "content", "type"], v)}
                      options={["none", "text", "logo", "monogram", "icon"]}
                    />
                  </FieldRow>
                  {config.property_pin?.content?.type === "text" && (
                    <FieldRow label="Text" fieldKey="property_pin.content.text">
                      <TextField
                        value={config.property_pin?.content?.text}
                        onChange={(v) => update(["property_pin", "content", "text"], v)}
                      />
                    </FieldRow>
                  )}
                  {config.property_pin?.content?.type === "monogram" && (
                    <FieldRow label="Monogram" fieldKey="property_pin.content.monogram">
                      <TextField
                        value={config.property_pin?.content?.monogram}
                        onChange={(v) => update(["property_pin", "content", "monogram"], v)}
                        placeholder="e.g. AB"
                      />
                    </FieldRow>
                  )}
                  {config.property_pin?.content?.type === "icon" && (
                    <FieldRow label="Icon name" fieldKey="property_pin.content.icon_name">
                      <TextField
                        value={config.property_pin?.content?.icon_name}
                        onChange={(v) => update(["property_pin", "content", "icon_name"], v)}
                        placeholder="home"
                        mono
                      />
                    </FieldRow>
                  )}
                  {config.property_pin?.content?.type === "logo" && (
                    <FieldRow label="Logo asset" hint="Dropbox path (placeholder)" fieldKey="property_pin.content.logo_asset_ref">
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
                      <FieldRow label="Text color" fieldKey="property_pin.content.text_color">
                        <ColorField
                          value={config.property_pin?.content?.text_color}
                          onChange={(v) =>
                            update(["property_pin", "content", "text_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Text size" fieldKey="property_pin.content.text_size_px">
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
                    <FieldRow label="Icon color" fieldKey="property_pin.content.icon_color">
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
                  <FieldRow label="Enabled" fieldKey="property_pin.address_label.enabled">
                    <SwitchField
                      value={config.property_pin?.address_label?.enabled}
                      onChange={(v) =>
                        update(["property_pin", "address_label", "enabled"], v)
                      }
                    />
                  </FieldRow>
                  {config.property_pin?.address_label?.enabled && (
                    <>
                      <FieldRow label="Position" fieldKey="property_pin.address_label.position">
                        <SelectField
                          value={config.property_pin?.address_label?.position}
                          onChange={(v) =>
                            update(["property_pin", "address_label", "position"], v)
                          }
                          options={["below", "above"]}
                        />
                      </FieldRow>
                      <FieldRow label="Text color" fieldKey="property_pin.address_label.text_color">
                        <ColorField
                          value={config.property_pin?.address_label?.text_color}
                          onChange={(v) =>
                            update(["property_pin", "address_label", "text_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Background" fieldKey="property_pin.address_label.bg_color">
                        <ColorField
                          value={config.property_pin?.address_label?.bg_color}
                          onChange={(v) =>
                            update(["property_pin", "address_label", "bg_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Font size" fieldKey="property_pin.address_label.font_size_px">
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
              </>
            )}
          </SectionAccordion>
        );

      case "boundary":
        return (
          <SectionAccordion
            id="boundary"
            label="Boundary outline"
            openId={openSection}
            onToggle={setOpenSection}
            badge={config.boundary?.enabled ? "On" : "Off"}
            canReset={canEdit}
            onReset={() => resetSection("boundary")}
          >
            <FieldRow label="Enabled" fieldKey="boundary.enabled">
              <SwitchField
                value={config.boundary?.enabled}
                onChange={(v) => update(["boundary", "enabled"], v)}
              />
            </FieldRow>

            {config.boundary?.enabled && (
              <>
                <div className="mt-3 pt-2 border-t border-dashed border-muted">
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Line</p>
                  <FieldRow label="Style" fieldKey="boundary.line.style">
                    <SelectField
                      value={config.boundary?.line?.style}
                      onChange={(v) => update(["boundary", "line", "style"], v)}
                      options={["solid", "dashed", "dotted"]}
                    />
                  </FieldRow>
                  <FieldRow label="Width" fieldKey="boundary.line.width_px">
                    <NumberField
                      value={config.boundary?.line?.width_px}
                      onChange={(v) => update(["boundary", "line", "width_px"], v)}
                      min={1}
                      max={50}
                      suffix="px"
                    />
                  </FieldRow>
                  <FieldRow label="Color" fieldKey="boundary.line.color">
                    <ColorField
                      value={config.boundary?.line?.color}
                      onChange={(v) => update(["boundary", "line", "color"], v)}
                    />
                  </FieldRow>
                  <FieldRow label="Corner radius" fieldKey="boundary.line.corner_radius_px">
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
                  <FieldRow label="Shadow" fieldKey="boundary.line.shadow.enabled">
                    <SwitchField
                      value={config.boundary?.line?.shadow?.enabled}
                      onChange={(v) =>
                        update(["boundary", "line", "shadow", "enabled"], v)
                      }
                    />
                  </FieldRow>
                  {config.boundary?.line?.shadow?.enabled && (
                    <>
                      {/* Audit fix: shadow color/offset/blur were never editable
                          before — only the enabled toggle was wired. (#audit) */}
                      <FieldRow label="Shadow color" fieldKey="boundary.line.shadow.color">
                        <ColorField
                          value={config.boundary?.line?.shadow?.color}
                          onChange={(v) =>
                            update(["boundary", "line", "shadow", "color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Shadow offset X" fieldKey="boundary.line.shadow.offset_x_px">
                        <NumberField
                          value={config.boundary?.line?.shadow?.offset_x_px}
                          onChange={(v) =>
                            update(["boundary", "line", "shadow", "offset_x_px"], v)
                          }
                          min={-40}
                          max={40}
                          suffix="px"
                        />
                      </FieldRow>
                      <FieldRow label="Shadow offset Y" fieldKey="boundary.line.shadow.offset_y_px">
                        <NumberField
                          value={config.boundary?.line?.shadow?.offset_y_px}
                          onChange={(v) =>
                            update(["boundary", "line", "shadow", "offset_y_px"], v)
                          }
                          min={-40}
                          max={40}
                          suffix="px"
                        />
                      </FieldRow>
                      <FieldRow label="Shadow blur" fieldKey="boundary.line.shadow.blur_px">
                        <NumberField
                          value={config.boundary?.line?.shadow?.blur_px}
                          onChange={(v) =>
                            update(["boundary", "line", "shadow", "blur_px"], v)
                          }
                          min={0}
                          max={40}
                          suffix="px"
                        />
                      </FieldRow>
                    </>
                  )}
                </div>

                <div className="mt-3 pt-2 border-t border-dashed border-muted">
                  <p className="text-xs font-semibold text-muted-foreground mb-1">
                    Exterior treatment
                  </p>
                  <FieldRow label="Blur" fieldKey="boundary.exterior_treatment.blur_enabled">
                    <SwitchField
                      value={config.boundary?.exterior_treatment?.blur_enabled}
                      onChange={(v) =>
                        update(["boundary", "exterior_treatment", "blur_enabled"], v)
                      }
                    />
                  </FieldRow>
                  {config.boundary?.exterior_treatment?.blur_enabled && (
                    <FieldRow label="Blur strength" fieldKey="boundary.exterior_treatment.blur_strength_px">
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
                  <FieldRow label="Darken" hint="0.0 – 1.0 (1 = unchanged)" fieldKey="boundary.exterior_treatment.darken_factor">
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
                  <FieldRow label="Hue shift" hint="-180 to +180" fieldKey="boundary.exterior_treatment.hue_shift_degrees">
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
                  <FieldRow label="Saturation" hint="0.0 = grayscale" fieldKey="boundary.exterior_treatment.saturation_factor">
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
                  <FieldRow label="Lightness" fieldKey="boundary.exterior_treatment.lightness_factor">
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
                  <FieldRow label="Enabled" fieldKey="boundary.side_measurements.enabled">
                    <SwitchField
                      value={config.boundary?.side_measurements?.enabled}
                      onChange={(v) =>
                        update(["boundary", "side_measurements", "enabled"], v)
                      }
                    />
                  </FieldRow>
                  {config.boundary?.side_measurements?.enabled && (
                    <>
                      <FieldRow label="Unit" fieldKey="boundary.side_measurements.unit">
                        <SelectField
                          value={config.boundary?.side_measurements?.unit}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "unit"], v)
                          }
                          options={["metres", "feet"]}
                        />
                      </FieldRow>
                      <FieldRow label="Decimals" fieldKey="boundary.side_measurements.decimals">
                        <NumberField
                          value={config.boundary?.side_measurements?.decimals}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "decimals"], v)
                          }
                          min={0}
                          max={4}
                        />
                      </FieldRow>
                      <FieldRow label="Position" fieldKey="boundary.side_measurements.position">
                        <SelectField
                          value={config.boundary?.side_measurements?.position}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "position"], v)
                          }
                          options={["outside", "inside"]}
                        />
                      </FieldRow>
                      {/* Bug #3 — text styling fields were unreachable. */}
                      <FieldRow label="Text color" fieldKey="boundary.side_measurements.text_color">
                        <ColorField
                          value={config.boundary?.side_measurements?.text_color}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "text_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Text outline color" fieldKey="boundary.side_measurements.text_outline_color">
                        <ColorField
                          value={config.boundary?.side_measurements?.text_outline_color}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "text_outline_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Text outline width" fieldKey="boundary.side_measurements.text_outline_width_px">
                        <NumberField
                          value={config.boundary?.side_measurements?.text_outline_width_px}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "text_outline_width_px"], v)
                          }
                          min={0}
                          max={20}
                          suffix="px"
                        />
                      </FieldRow>
                      <FieldRow label="Font size" fieldKey="boundary.side_measurements.font_size_px">
                        <NumberField
                          value={config.boundary?.side_measurements?.font_size_px}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "font_size_px"], v)
                          }
                          min={6}
                          max={200}
                          suffix="px"
                        />
                      </FieldRow>
                      <FieldRow label="Font family" hint="must exist on render server" fieldKey="boundary.side_measurements.font_family">
                        <TextField
                          value={config.boundary?.side_measurements?.font_family}
                          onChange={(v) =>
                            update(["boundary", "side_measurements", "font_family"], v)
                          }
                          placeholder="DejaVu Sans"
                          mono
                        />
                      </FieldRow>
                    </>
                  )}
                </div>

                <div className="mt-3 pt-2 border-t border-dashed border-muted">
                  <p className="text-xs font-semibold text-muted-foreground mb-1">
                    Sqm total
                  </p>
                  <FieldRow label="Enabled" fieldKey="boundary.sqm_total.enabled">
                    <SwitchField
                      value={config.boundary?.sqm_total?.enabled}
                      onChange={(v) => update(["boundary", "sqm_total", "enabled"], v)}
                    />
                  </FieldRow>
                  {/* Bug #3 — sqm_total text/template/font/colors/shadow were unreachable. */}
                  {config.boundary?.sqm_total?.enabled && (
                    <>
                      <FieldRow label="Template" hint="{sqm} → e.g. '1,250'" fieldKey="boundary.sqm_total.text_template">
                        <TextField
                          value={config.boundary?.sqm_total?.text_template}
                          onChange={(v) =>
                            update(["boundary", "sqm_total", "text_template"], v)
                          }
                          placeholder="{sqm} sqm approx"
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Position" fieldKey="boundary.sqm_total.position">
                        <SelectField
                          value={config.boundary?.sqm_total?.position}
                          onChange={(v) =>
                            update(["boundary", "sqm_total", "position"], v)
                          }
                          options={[
                            { value: "centroid", label: "Centroid" },
                            { value: "top_left", label: "Top left" },
                            { value: "top_right", label: "Top right" },
                            { value: "bottom_left", label: "Bottom left" },
                            { value: "bottom_right", label: "Bottom right" },
                          ]}
                        />
                      </FieldRow>
                      <FieldRow label="Text color" fieldKey="boundary.sqm_total.text_color">
                        <ColorField
                          value={config.boundary?.sqm_total?.text_color}
                          onChange={(v) =>
                            update(["boundary", "sqm_total", "text_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Background" hint='hex or "transparent"' fieldKey="boundary.sqm_total.bg_color">
                        <ColorField
                          value={config.boundary?.sqm_total?.bg_color}
                          onChange={(v) =>
                            update(["boundary", "sqm_total", "bg_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Font size" fieldKey="boundary.sqm_total.font_size_px">
                        <NumberField
                          value={config.boundary?.sqm_total?.font_size_px}
                          onChange={(v) =>
                            update(["boundary", "sqm_total", "font_size_px"], v)
                          }
                          min={6}
                          max={400}
                          suffix="px"
                        />
                      </FieldRow>
                      <FieldRow label="Shadow" fieldKey="boundary.sqm_total.shadow.enabled">
                        <SwitchField
                          value={config.boundary?.sqm_total?.shadow?.enabled}
                          onChange={(v) =>
                            update(["boundary", "sqm_total", "shadow", "enabled"], v)
                          }
                        />
                      </FieldRow>
                      {config.boundary?.sqm_total?.shadow?.enabled && (
                        <>
                          <FieldRow label="Shadow color" fieldKey="boundary.sqm_total.shadow.color">
                            <ColorField
                              value={config.boundary?.sqm_total?.shadow?.color}
                              onChange={(v) =>
                                update(["boundary", "sqm_total", "shadow", "color"], v)
                              }
                            />
                          </FieldRow>
                          <FieldRow label="Shadow offset X" fieldKey="boundary.sqm_total.shadow.offset_x_px">
                            <NumberField
                              value={config.boundary?.sqm_total?.shadow?.offset_x_px}
                              onChange={(v) =>
                                update(["boundary", "sqm_total", "shadow", "offset_x_px"], v)
                              }
                              min={-40}
                              max={40}
                              suffix="px"
                            />
                          </FieldRow>
                          <FieldRow label="Shadow offset Y" fieldKey="boundary.sqm_total.shadow.offset_y_px">
                            <NumberField
                              value={config.boundary?.sqm_total?.shadow?.offset_y_px}
                              onChange={(v) =>
                                update(["boundary", "sqm_total", "shadow", "offset_y_px"], v)
                              }
                              min={-40}
                              max={40}
                              suffix="px"
                            />
                          </FieldRow>
                          <FieldRow label="Shadow blur" fieldKey="boundary.sqm_total.shadow.blur_px">
                            <NumberField
                              value={config.boundary?.sqm_total?.shadow?.blur_px}
                              onChange={(v) =>
                                update(["boundary", "sqm_total", "shadow", "blur_px"], v)
                              }
                              min={0}
                              max={40}
                              suffix="px"
                            />
                          </FieldRow>
                        </>
                      )}
                    </>
                  )}
                </div>

                <div className="mt-3 pt-2 border-t border-dashed border-muted">
                  <p className="text-xs font-semibold text-muted-foreground mb-1">
                    Address overlay
                  </p>
                  <FieldRow label="Enabled" fieldKey="boundary.address_overlay.enabled">
                    <SwitchField
                      value={config.boundary?.address_overlay?.enabled}
                      onChange={(v) =>
                        update(["boundary", "address_overlay", "enabled"], v)
                      }
                    />
                  </FieldRow>
                  {/* Bug #3 — address_overlay position/template/colors/shadow were unreachable. */}
                  {config.boundary?.address_overlay?.enabled && (
                    <>
                      <FieldRow label="Position" fieldKey="boundary.address_overlay.position">
                        <SelectField
                          value={config.boundary?.address_overlay?.position}
                          onChange={(v) =>
                            update(["boundary", "address_overlay", "position"], v)
                          }
                          options={[
                            { value: "below_sqm", label: "Below sqm" },
                            { value: "above_sqm", label: "Above sqm" },
                            { value: "centroid", label: "Centroid" },
                          ]}
                        />
                      </FieldRow>
                      <FieldRow label="Template" hint="{address}, {street_number}, {street_name}" fieldKey="boundary.address_overlay.text_template">
                        <TextField
                          value={config.boundary?.address_overlay?.text_template}
                          onChange={(v) =>
                            update(["boundary", "address_overlay", "text_template"], v)
                          }
                          placeholder="{street_number} {street_name}"
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Text color" fieldKey="boundary.address_overlay.text_color">
                        <ColorField
                          value={config.boundary?.address_overlay?.text_color}
                          onChange={(v) =>
                            update(["boundary", "address_overlay", "text_color"], v)
                          }
                        />
                      </FieldRow>
                      <FieldRow label="Font size" fieldKey="boundary.address_overlay.font_size_px">
                        <NumberField
                          value={config.boundary?.address_overlay?.font_size_px}
                          onChange={(v) =>
                            update(["boundary", "address_overlay", "font_size_px"], v)
                          }
                          min={6}
                          max={200}
                          suffix="px"
                        />
                      </FieldRow>
                      <FieldRow label="Shadow" fieldKey="boundary.address_overlay.shadow_enabled">
                        <SwitchField
                          value={config.boundary?.address_overlay?.shadow_enabled}
                          onChange={(v) =>
                            update(["boundary", "address_overlay", "shadow_enabled"], v)
                          }
                        />
                      </FieldRow>
                    </>
                  )}
                </div>
              </>
            )}
          </SectionAccordion>
        );

      case "branding_ribbon":
        return (
          <SectionAccordion
            id="branding_ribbon"
            label="Branding ribbon"
            openId={openSection}
            onToggle={setOpenSection}
            badge={config.branding_ribbon?.enabled ? "On" : "Off"}
            canReset={canEdit}
            onReset={() => resetSection("branding_ribbon")}
          >
            <FieldRow label="Enabled" fieldKey="branding_ribbon.enabled">
              <SwitchField
                value={config.branding_ribbon?.enabled}
                onChange={(v) => update(["branding_ribbon", "enabled"], v)}
              />
            </FieldRow>
            {config.branding_ribbon?.enabled && (
              <>
                <FieldRow label="Position" fieldKey="branding_ribbon.position">
                  <SelectField
                    value={config.branding_ribbon?.position}
                    onChange={(v) => update(["branding_ribbon", "position"], v)}
                    options={["top", "bottom"]}
                  />
                </FieldRow>
                <FieldRow label="Height" fieldKey="branding_ribbon.height_px">
                  <NumberField
                    value={config.branding_ribbon?.height_px}
                    onChange={(v) => update(["branding_ribbon", "height_px"], v)}
                    min={20}
                    max={400}
                    suffix="px"
                  />
                </FieldRow>
                <FieldRow label="Background" fieldKey="branding_ribbon.bg_color">
                  <ColorField
                    value={config.branding_ribbon?.bg_color}
                    onChange={(v) => update(["branding_ribbon", "bg_color"], v)}
                  />
                </FieldRow>
                <FieldRow label="Text color" fieldKey="branding_ribbon.text_color">
                  <ColorField
                    value={config.branding_ribbon?.text_color}
                    onChange={(v) => update(["branding_ribbon", "text_color"], v)}
                  />
                </FieldRow>
                <FieldRow label="Show org logo" fieldKey="branding_ribbon.show_org_logo">
                  <SwitchField
                    value={config.branding_ribbon?.show_org_logo}
                    onChange={(v) => update(["branding_ribbon", "show_org_logo"], v)}
                  />
                </FieldRow>
                {config.branding_ribbon?.show_org_logo && (
                  <>
                    <FieldRow label="Logo asset" hint="Dropbox path (placeholder)" fieldKey="branding_ribbon.logo_asset_ref">
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
                    {/* Bug #4 — logo_position + logo_height_px were unreachable. */}
                    <FieldRow label="Logo position" fieldKey="branding_ribbon.logo_position">
                      <SelectField
                        value={config.branding_ribbon?.logo_position}
                        onChange={(v) => update(["branding_ribbon", "logo_position"], v)}
                        options={[
                          { value: "left", label: "Left" },
                          { value: "right", label: "Right" },
                        ]}
                      />
                    </FieldRow>
                    <FieldRow label="Logo height" fieldKey="branding_ribbon.logo_height_px">
                      <NumberField
                        value={config.branding_ribbon?.logo_height_px}
                        onChange={(v) => update(["branding_ribbon", "logo_height_px"], v)}
                        min={10}
                        max={400}
                        suffix="px"
                      />
                    </FieldRow>
                  </>
                )}
                <FieldRow label="Show address" fieldKey="branding_ribbon.show_address">
                  <SwitchField
                    value={config.branding_ribbon?.show_address}
                    onChange={(v) => update(["branding_ribbon", "show_address"], v)}
                  />
                </FieldRow>
                {/* Bug #4 — address_font_size_px was unreachable. */}
                {config.branding_ribbon?.show_address && (
                  <FieldRow label="Address font size" fieldKey="branding_ribbon.address_font_size_px">
                    <NumberField
                      value={config.branding_ribbon?.address_font_size_px}
                      onChange={(v) => update(["branding_ribbon", "address_font_size_px"], v)}
                      min={6}
                      max={200}
                      suffix="px"
                    />
                  </FieldRow>
                )}
                <FieldRow label="Show shot ID" fieldKey="branding_ribbon.show_shot_id">
                  <SwitchField
                    value={config.branding_ribbon?.show_shot_id}
                    onChange={(v) => update(["branding_ribbon", "show_shot_id"], v)}
                  />
                </FieldRow>
              </>
            )}
          </SectionAccordion>
        );

      case "output_variants":
        return (
          <SectionAccordion
            id="output_variants"
            label="Output variants"
            openId={openSection}
            onToggle={setOpenSection}
            badge={`${variants.length}`}
            canReset={canEdit}
            onReset={() => resetSection("output_variants")}
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
                  <FieldRow label="Name" fieldKey="output_variants[].name">
                    <TextField
                      value={v.name}
                      onChange={(val) => updateVariant(idx, "name", val)}
                    />
                  </FieldRow>
                  <FieldRow label="Format" fieldKey="output_variants[].format">
                    <SelectField
                      value={v.format}
                      onChange={(val) => updateVariant(idx, "format", val)}
                      options={["JPEG", "TIFF", "PNG"]}
                    />
                  </FieldRow>
                  <FieldRow label="Quality" hint="JPEG: 0–100" fieldKey="output_variants[].quality">
                    <NumberField
                      value={v.quality}
                      onChange={(val) => updateVariant(idx, "quality", val)}
                      min={1}
                      max={100}
                    />
                  </FieldRow>
                  <FieldRow label="Width" fieldKey="output_variants[].target_width_px">
                    <NumberField
                      value={v.target_width_px}
                      onChange={(val) => updateVariant(idx, "target_width_px", val)}
                      min={100}
                      max={20000}
                      suffix="px"
                    />
                  </FieldRow>
                  <FieldRow label="Aspect" fieldKey="output_variants[].aspect">
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
                  <FieldRow label="Max bytes" fieldKey="output_variants[].max_bytes">
                    <NumberField
                      value={v.max_bytes}
                      onChange={(val) => updateVariant(idx, "max_bytes", val)}
                      min={0}
                    />
                  </FieldRow>
                  <FieldRow label="Color profile" fieldKey="output_variants[].color_profile">
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
        );

      case "safety_rules":
        return (
          <SectionAccordion
            id="safety_rules"
            label="Safety rules (read-only)"
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
        );

      default:
        return null;
    }
  }

  // Helper used by the section grouping nav: render the title-bar for one
  // collapsible group. Click toggles which group is expanded.
  function renderGroupHeader(groupId, label, Icon) {
    const open = openGroup === groupId;
    return (
      <button
        type="button"
        onClick={() => setOpenGroup(open ? null : groupId)}
        className={cn(
          "w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md text-xs font-semibold uppercase tracking-wide transition-colors",
          open ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/40",
        )}
      >
        <span className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
    );
  }

  return (
    // Bug #16 — single TooltipProvider for all HelpTips in this editor.
    // Previously every HelpTip mounted its own (~100 instances per render).
    <HelpTipProvider>
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
              <Badge variant="outline" className="text-[10px] font-normal" title={`version_int: ${versionInt ?? "?"}`}>
                v{version}
              </Badge>
            )}
            {status === "archived" && (
              <Badge
                variant="outline"
                className="text-[10px] font-normal text-muted-foreground"
                title="Archived themes are kept for history but not used in renders"
              >
                Archived
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCancelClick} disabled={saving}>
              Cancel
            </Button>
            {themeId && canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onClickSave({ saveAsNew: true })}
                disabled={saving || !name.trim() || invalidColorCount > 0}
                title={
                  invalidColorCount > 0
                    ? `Fix ${invalidColorCount} invalid colour value${invalidColorCount === 1 ? "" : "s"} first`
                    : "Save as a new theme (preserves the original)"
                }
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                Save as new
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                onClick={() => onClickSave({ saveAsNew: false })}
                disabled={saving || !name.trim() || invalidColorCount > 0}
                title={
                  invalidColorCount > 0
                    ? `Fix ${invalidColorCount} invalid colour value${invalidColorCount === 1 ? "" : "s"} first`
                    : undefined
                }
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

      {/* Inheritance + validation hints */}
      <div className="flex flex-col gap-2">
        {ownerKind !== "system" && (
          <div className="rounded-md border border-input bg-muted/30 px-3 py-2 flex items-start gap-2 text-xs">
            <Palette className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-foreground">
                Editing a <span className="font-medium">{ownerKind === "person" ? "person-level" : "organisation-level"}</span> theme.
                Any field you leave at the FlexMedia default value will continue to inherit
                {ownerKind === "person" ? " from this person's organisation, then from FlexMedia's system default." : " from FlexMedia's system default."}
              </p>
              {canEdit && (
                <button
                  type="button"
                  onClick={resetToDefaults}
                  className="text-[11px] text-primary hover:underline mt-1"
                >
                  Reset every field to FlexMedia defaults
                </button>
              )}
            </div>
          </div>
        )}
        {invalidColorCount > 0 && (
          <div
            role="alert"
            className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-3 py-2 flex items-start gap-2 text-xs"
          >
            <AlertCircle className="h-3.5 w-3.5 text-red-600 mt-0.5 shrink-0" />
            <p className="text-red-700 dark:text-red-200">
              {invalidColorCount} colour{invalidColorCount === 1 ? "" : "s"} {invalidColorCount === 1 ? "is" : "are"} not a valid hex value (e.g. #FFFFFF). Save is disabled until fixed.
            </p>
          </div>
        )}
      </div>

      {/* ── Three-column layout: nav + form + previews ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr_360px] gap-3">
        {/* Sidebar nav: two collapsible groups */}
        <Card className="self-start lg:sticky lg:top-3">
          <CardContent className="p-2 space-y-2">
            <div>
              {renderGroupHeader("poi", "POI overlay", MousePointer)}
              {openGroup === "poi" && (
                <div className="mt-1 ml-1 space-y-0.5">
                  {SECTIONS_BY_GROUP.poi.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setOpenSection(s.id)}
                      className={cn(
                        "w-full text-left text-xs px-2.5 py-1.5 rounded-md transition-colors",
                        openSection === s.id
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-foreground/80 hover:bg-muted/60",
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              {renderGroupHeader("render", "Nadir / Oblique render", MapIcon)}
              {openGroup === "render" && (
                <div className="mt-1 ml-1 space-y-0.5">
                  {SECTIONS_BY_GROUP.render.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setOpenSection(s.id)}
                      className={cn(
                        "w-full text-left text-xs px-2.5 py-1.5 rounded-md transition-colors",
                        openSection === s.id
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-foreground/80 hover:bg-muted/60",
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Form column */}
        <Card>
          <CardContent className="p-3 space-y-1">
            {[...SECTIONS_BY_GROUP.poi, ...SECTIONS_BY_GROUP.render].map((s) => (
              <div key={s.id}>{renderSection(s.id)}</div>
            ))}
          </CardContent>
        </Card>

        {/* Preview column — three tabs */}
        <Card className="self-start lg:sticky lg:top-3 bg-muted/20">
          <CardContent className="p-3 space-y-3">
            <Tabs value={previewTab} onValueChange={setPreviewTab}>
              <TabsList className="grid w-full grid-cols-3 h-8">
                <TabsTrigger value="nadir" className="text-[10px] gap-1">
                  <Camera className="h-3 w-3" />
                  Nadir
                </TabsTrigger>
                <TabsTrigger value="oblique" className="text-[10px] gap-1">
                  <Camera className="h-3 w-3" />
                  Oblique
                </TabsTrigger>
                <TabsTrigger value="poi" className="text-[10px] gap-1">
                  <MousePointer className="h-3 w-3" />
                  POI
                </TabsTrigger>
              </TabsList>

              <TabsContent value="nadir" className="mt-2">
                <div className="rounded-md overflow-hidden border border-input">
                  <NadirPreview config={config} />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  Top-down view sample. Property pin + boundary + POI labels overlaid.
                </p>
              </TabsContent>

              <TabsContent value="oblique" className="mt-2">
                <div className="rounded-md overflow-hidden border border-input">
                  <ObliquePreview config={config} />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  Angled (oblique) view sample. Same overlays as Nadir.
                </p>
              </TabsContent>

              <TabsContent value="poi" className="mt-2">
                <div className="rounded-md overflow-hidden border border-input">
                  <PoiCloseupPreview config={config} />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  Close-up of one POI label + anchor line. Pure styling preview.
                </p>
              </TabsContent>
            </Tabs>

            {/* Server-side preview (slow, accurate) ─ opt-in */}
            <div className="pt-3 mt-2 border-t border-dashed border-muted space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Render full preview
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={triggerServerPreview}
                  disabled={previewLoading}
                  className="h-7 text-[10px] gap-1.5"
                  title="Calls drone-render-preview against a bundled DJI fixture (1-2 s)"
                >
                  {previewLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  {previewLoading ? "Rendering" : "Render (slow)"}
                </Button>
              </div>
              {previewImg && (
                <div className="relative aspect-video rounded-md border border-input bg-muted/40 overflow-hidden">
                  <img
                    src={previewImg}
                    alt="Server-side preview"
                    className="w-full h-full object-contain bg-black"
                    draggable={false}
                  />
                  {previewLoading && (
                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-white/90" />
                    </div>
                  )}
                </div>
              )}
              {previewError && (
                <div
                  role="alert"
                  className="rounded-md border border-red-200 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/30 px-2 py-1.5 flex items-start gap-2"
                >
                  <AlertCircle className="h-3 w-3 text-red-600 mt-0.5 shrink-0" />
                  <p className="text-[10px] text-red-700 dark:text-red-300 break-words">
                    {previewError}
                  </p>
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">
                Renders against a bundled DJI fixture; not your project's actual shots.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Save-confirmation dialog (existing themes only) ──────────────── */}
      <AlertDialog open={saveDialogOpen} onOpenChange={(open) => {
        if (!saving && !rerendering) setSaveDialogOpen(open);
      }}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Save changes?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  This will update the theme to version{" "}
                  <span className="font-mono font-semibold">
                    {versionInt != null ? versionInt + 1 : "?"}
                  </span>
                  .{" "}
                  {impactRpcAvailable ? (
                    impactRows.length > 0 ? (
                      <>The following projects have renders that were produced from the previous version:</>
                    ) : impactLoading ? (
                      <>Checking which projects are impacted…</>
                    ) : (
                      <>No in-flight projects have renders from the previous version of this theme.</>
                    )
                  ) : (
                    <span className="text-muted-foreground italic" title="The drone_theme_impacted_projects RPC isn't available in this environment. Save proceeds without the auto-rerender option.">
                      Impact list unavailable.
                    </span>
                  )}
                </p>

                {impactLoading && (
                  <div className="flex items-center gap-2 py-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading impacted projects…
                  </div>
                )}

                {!impactLoading && impactRows.length > 0 && (
                  <div className="rounded-md border border-input bg-muted/30 p-2.5 max-h-48 overflow-y-auto">
                    <ul className="space-y-1">
                      {impactRows.slice(0, 25).map((r) => (
                        <li key={r.shoot_id} className="text-xs flex items-center justify-between gap-2">
                          <span className="font-medium truncate">
                            {r.project_address || r.project_id?.slice(0, 8)}
                          </span>
                          <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                            {r.renders_count} render{r.renders_count === 1 ? "" : "s"} · {r.shoot_status}
                          </span>
                        </li>
                      ))}
                      {impactRows.length > 25 && (
                        <li className="text-[10px] text-muted-foreground italic pt-1">
                          …and {impactRows.length - 25} more
                        </li>
                      )}
                    </ul>
                    {/* QC6 #25: server-side cap hit at 200 rows. Surface
                        the truncation explicitly so the operator can't
                        believe the listed shoots are the entirety of the
                        impact. (The server still caps; client side just
                        reflects the flag.) */}
                    {impactTruncated && (
                      <div className="mt-2 border-t border-amber-300 dark:border-amber-700 pt-1.5 text-[10px] text-amber-700 dark:text-amber-300 flex items-start gap-1">
                        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>
                          Impact list truncated at 200 shoots — additional
                          shoots use this theme but are not shown. Re-render
                          covers only the listed shoots.
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {!impactLoading && impactRows.length > 0 && (
                  <label className="flex items-center gap-2 cursor-pointer text-xs">
                    <Checkbox
                      checked={autoRerender}
                      onCheckedChange={(v) => setAutoRerender(!!v)}
                      disabled={rerendering}
                    />
                    <span>
                      Auto-re-render impacted projects with the new theme
                    </span>
                  </label>
                )}

                {rerendering && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Queuing re-renders…
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSaveDialogOpen(false)}
              disabled={saving || rerendering}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onConfirmSaveFromDialog({ withRerender: false })}
              disabled={saving || rerendering}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Save (won't re-render)
            </Button>
            <Button
              size="sm"
              onClick={() => onConfirmSaveFromDialog({ withRerender: true })}
              disabled={saving || rerendering || impactRows.length === 0 || !autoRerender}
              title={
                impactRows.length === 0
                  ? "No impacted projects to re-render"
                  : !autoRerender
                    ? "Tick the auto-rerender option to enable"
                    : undefined
              }
            >
              {(saving || rerendering) ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save + Re-render
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </HelpTipProvider>
  );
}

// ── POI type checklist row (one per supported Google Places category) ─────
// Tick to enable; per-type Max + Priority drive how the global Max-pins-per-
// shot budget is filled. When unchecked, the key is removed from
// poi_selection.type_quotas entirely so drone-pois treats it as opted-out.
function PoiTypeChecklistRow({
  option,
  enabled,
  max,
  priority,
  onToggle,
  onChangeMax,
  onChangePriority,
  disabled,
}) {
  return (
    <div className="grid grid-cols-[24px_1fr_72px_72px] gap-2 items-center">
      <Checkbox
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="h-4 w-4"
      />
      <Label
        className={cn(
          "text-xs cursor-pointer select-none",
          !enabled && "text-muted-foreground",
        )}
        onClick={() => !disabled && onToggle()}
      >
        {option.label}
      </Label>
      <Input
        type="number"
        value={enabled ? max : ""}
        onChange={(e) => onChangeMax(Number(e.target.value))}
        disabled={!enabled || disabled}
        min={0}
        max={20}
        placeholder="—"
        className="h-7 text-xs text-center"
      />
      <Input
        type="number"
        value={enabled ? priority : ""}
        onChange={(e) => onChangePriority(Number(e.target.value))}
        disabled={!enabled || disabled}
        min={1}
        max={99}
        placeholder="—"
        className="h-7 text-xs text-center"
      />
    </div>
  );
}

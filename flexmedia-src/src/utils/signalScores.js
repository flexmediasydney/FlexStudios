// Signal score helpers for the shortlisting UI.
//
// Mirrors the canonical taxonomy in
// `supabase/functions/_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts`:
//   - UNIVERSAL_SIGNAL_KEYS — the 26 fixed signal keys per image
//   - SIGNAL_TO_DIMENSION   — which dimension each signal rolls up into
//
// Keep this file in sync with the schema file when signals change.  The
// engine treats Workflow signals (retouch_debt, gallery_arc_position,
// social_crop_survival, brochure_print_survival) as observability-only —
// they do not contribute to any dimension aggregate, but operators want
// to see them in the lightbox grouped under their own header.
//
// Used by:
//   - ShortlistingCard.jsx   — hover cards per dimension score
//   - ShortlistingLightbox.jsx — full categorized score panel

/**
 * 26 canonical signal keys in stable display order.  Order matches the
 * schema file so an operator scanning down the list always sees them in
 * the same sequence regardless of which image they're inspecting.
 */
export const UNIVERSAL_SIGNAL_KEYS = [
  // Technical (6)
  'exposure_balance',
  'color_cast',
  'sharpness_subject',
  'sharpness_corners',
  'plumb_verticals',
  'perspective_distortion',
  // Lighting (4)
  'light_quality',
  'light_directionality',
  'color_temperature_appropriateness',
  'light_falloff_quality',
  // Composition (8)
  'depth_layering',
  'composition_geometry',
  'vantage_quality',
  'framing_quality',
  'leading_lines',
  'negative_space',
  'symmetry_quality',
  'foreground_anchor',
  // Aesthetic (4)
  'material_specificity',
  'period_reading',
  'styling_quality',
  'distraction_freeness',
  // Workflow (4) — observability-only, no dimension contribution
  'retouch_debt',
  'gallery_arc_position',
  'social_crop_survival',
  'brochure_print_survival',
];

/**
 * Per-signal → dimension mapping.  The 4 workflow signals are intentionally
 * absent: they are observability-only and don't roll up into a dimension.
 */
export const SIGNAL_TO_DIMENSION = {
  // technical
  exposure_balance: 'technical',
  color_cast: 'technical',
  sharpness_subject: 'technical',
  sharpness_corners: 'technical',
  plumb_verticals: 'technical',
  perspective_distortion: 'technical',
  // lighting
  light_quality: 'lighting',
  light_directionality: 'lighting',
  color_temperature_appropriateness: 'lighting',
  light_falloff_quality: 'lighting',
  // composition
  depth_layering: 'composition',
  composition_geometry: 'composition',
  vantage_quality: 'composition',
  framing_quality: 'composition',
  leading_lines: 'composition',
  negative_space: 'composition',
  symmetry_quality: 'composition',
  foreground_anchor: 'composition',
  // aesthetic
  material_specificity: 'aesthetic',
  period_reading: 'aesthetic',
  styling_quality: 'aesthetic',
  distraction_freeness: 'aesthetic',
};

/**
 * Display order of the 5 categories in UI.  Workflow renders last because
 * it doesn't roll up into the composite — operators want it visible but
 * shouldn't conflate it with the 4 main dimensions.
 */
export const SIGNAL_CATEGORIES = [
  { key: 'technical', label: 'Technical', shortLabel: 'T', isDimension: true },
  { key: 'lighting', label: 'Lighting', shortLabel: 'L', isDimension: true },
  { key: 'composition', label: 'Composition', shortLabel: 'C', isDimension: true },
  { key: 'aesthetic', label: 'Aesthetic', shortLabel: 'A', isDimension: true },
  { key: 'workflow', label: 'Workflow', shortLabel: 'W', isDimension: false },
];

const WORKFLOW_KEYS = new Set([
  'retouch_debt',
  'gallery_arc_position',
  'social_crop_survival',
  'brochure_print_survival',
]);

/**
 * Convert a snake_case signal key to a human label.  Mirrors
 * humanSignalLabel() in ShortlistingLightbox.jsx — extracted here so we
 * can reuse it everywhere without duplicating the trivial snake-to-title
 * conversion.
 */
export function humanSignalLabel(key) {
  if (!key) return '';
  return String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Pull a numeric score out of a signal_scores entry.  The Modal/Pass1
 * pipeline writes either a flat number or an object `{raw, normalized}`
 * (legacy shape).  Returns null when the score is missing or
 * non-numeric so callers can skip without rendering noise.
 */
export function readSignalValue(entry) {
  if (typeof entry === 'number') return Number.isFinite(entry) ? entry : null;
  if (entry && typeof entry === 'object') {
    if (typeof entry.normalized === 'number' && Number.isFinite(entry.normalized)) {
      return entry.normalized;
    }
    if (typeof entry.raw === 'number' && Number.isFinite(entry.raw)) {
      return entry.raw;
    }
  }
  return null;
}

/**
 * Group a signal_scores JSONB blob into the 5 display categories.
 *
 * Returns:
 *   {
 *     technical:   [{ key, label, value }, ...],   // dimension rollup
 *     lighting:    [...],
 *     composition: [...],
 *     aesthetic:   [...],
 *     workflow:    [...],   // observability-only
 *   }
 *
 * Each category's array is in the order defined by UNIVERSAL_SIGNAL_KEYS
 * (NOT by score) so the operator's eye can scan a stable layout.  Signals
 * that are null/missing in the input are omitted from the output entirely.
 *
 * Pure — safe to call inside React render or useMemo.
 */
export function groupSignalsByCategory(signalScores) {
  const out = {
    technical: [],
    lighting: [],
    composition: [],
    aesthetic: [],
    workflow: [],
  };
  if (!signalScores || typeof signalScores !== 'object') return out;
  for (const key of UNIVERSAL_SIGNAL_KEYS) {
    const raw = signalScores[key];
    const value = readSignalValue(raw);
    if (value == null) continue;
    const entry = { key, label: humanSignalLabel(key), value };
    if (WORKFLOW_KEYS.has(key)) {
      out.workflow.push(entry);
    } else {
      const dim = SIGNAL_TO_DIMENSION[key];
      if (dim && out[dim]) out[dim].push(entry);
    }
  }
  return out;
}

/**
 * Pull just the signals for one dimension.  Used by the swimlane card's
 * per-dimension hover card so we don't recompute the full categorisation
 * for each of 4 hover triggers.  `dim` is one of
 * 'technical' | 'lighting' | 'composition' | 'aesthetic'.
 */
export function signalsForDimension(signalScores, dim) {
  if (!signalScores || typeof signalScores !== 'object') return [];
  const out = [];
  for (const key of UNIVERSAL_SIGNAL_KEYS) {
    if (SIGNAL_TO_DIMENSION[key] !== dim) continue;
    const value = readSignalValue(signalScores[key]);
    if (value == null) continue;
    out.push({ key, label: humanSignalLabel(key), value });
  }
  return out;
}

/**
 * Score → tailwind text colour.  Used in hover cards + lightbox so a
 * green 8.5 immediately reads as "good" and a red 4.0 as "concern".
 *   ≥ 8 → emerald
 *   ≥ 6 → amber
 *   < 6 → rose
 *   null → muted
 */
export function scoreColorClass(value) {
  if (value == null || !Number.isFinite(value)) return 'text-muted-foreground';
  if (value >= 8) return 'text-emerald-600 dark:text-emerald-400';
  if (value >= 6) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

/** Same color scale but for dark backgrounds (lightbox). */
export function scoreColorClassOnDark(value) {
  if (value == null || !Number.isFinite(value)) return 'text-white/60';
  if (value >= 8) return 'text-emerald-300';
  if (value >= 6) return 'text-amber-300';
  return 'text-rose-300';
}

/** Format a score for display: 2 dp, em-dash for null. */
export function formatSignalScore(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toFixed(2);
}

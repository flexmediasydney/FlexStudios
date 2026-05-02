/**
 * resolveGalleryPositions.ts — mig 444 / engine constraint-based positions.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Given a round's identifying scope (project_type + package_id + product_id +
 * price_tier + grade_id), returns the resolved ordered list of
 * `gallery_positions` for Stage 4 to fill.
 *
 * The new engine model (R1's mig 443) replaces the named-slot lattice with a
 * list of constraint tuples. Each row in `gallery_positions` (mig 443
 * schema) has columns:
 *   - position_index             int        ordering within the scope
 *   - phase                      text       'mandatory' | 'conditional' | 'optional'
 *   - room_type                  text|null  (NULL = wildcard)
 *   - space_type                 text|null
 *   - zone_focus                 text|null
 *   - shot_scale                 text|null  (wide|medium|tight|detail|vignette)
 *   - perspective_compression    text|null  (expanded|neutral|compressed)
 *   - orientation                text|null  (landscape|portrait|square)
 *   - lens_class                 text|null
 *   - image_type                 text|null
 *   - composition_type           text|null
 *   - selection_mode             text       'ai_decides' | 'curated'
 *   - ai_backfill_on_gap         boolean
 *   - notes                      text|null
 *   - template_slot_id           text|null  (soft ref, no FK)
 *
 * Scope key is composite per R1's mig 443:
 *   (scope_type, scope_ref_id, scope_ref_id_2, scope_ref_id_3)
 *
 *   'project_type'                          → ref_id=project_type_id
 *   'package_grade'                         → ref_id=package_id, ref_id_2=grade_id
 *   'package_x_price_tier'                  → ref_id=package_id, ref_id_2=price_tier_id
 *   'product'                               → ref_id=product_id
 *   'product_x_price_tier'                  → ref_id=product_id, ref_id_2=price_tier_id
 *   'package_x_price_tier_x_project_type'   → all 3 ref_ids set
 *
 * ─── Resolver order (last wins per position_index) ─────────────────────────
 *
 *  1. project_type                                 (broadest)
 *  2. package_grade            — package_id + grade_id
 *  3. package_x_price_tier     — package_id + price_tier_id
 *  4. product                  — product_id
 *  5. product_x_price_tier     — product_id + price_tier_id
 *  6. package_x_price_tier_x_project_type — package_id + price_tier_id + project_type_id
 *
 * Higher-specificity scopes overwrite earlier (lower-specificity) entries at
 * the same position_index. Within a scope, gallery_positions are ordered by
 * (position_index ASC).
 *
 * The resolver is fully tolerant of R1's mig 443 not being applied yet: when
 * the gallery_positions table is missing, the helper returns an empty list
 * with a warning. Callers can then fall back to legacy slot resolution.
 */

import type { getAdminClient } from './supabase.ts';

export type GalleryPositionPhase = 'mandatory' | 'conditional' | 'optional';

/** A single resolved gallery_position handed to Stage 4. Field names mirror
 * R1's mig 443 columns 1-to-1 (no prefix transformation). */
export interface ResolvedGalleryPosition {
  position_index: number;
  phase: GalleryPositionPhase;
  // Constraint axes — NULL means wildcard
  room_type: string | null;
  space_type: string | null;
  zone_focus: string | null;
  shot_scale: string | null;
  perspective_compression: string | null;
  orientation: string | null;
  lens_class: string | null;
  image_type: string | null;
  composition_type: string | null;
  // Behaviour
  selection_mode: string; // 'ai_decides' | 'curated'  (per R1's CHECK)
  ai_backfill_on_gap: boolean;
  notes: string | null;
  template_slot_id: string | null;
  // Provenance — which scope_type+scope_ref_ids won this position_index
  resolved_from_scope_type: string;
  resolved_from_scope_ref_id: string;
}

export interface ResolveGalleryPositionsArgs {
  admin: ReturnType<typeof getAdminClient>;
  /** project_type_id (uuid). NULL omits the project_type scope from the merge. */
  project_type_id: string | null;
  /** package_id (uuid). NULL omits the package_*-rooted scopes. */
  package_id: string | null;
  /** product_id (uuid). NULL omits the product_*-rooted scopes. */
  product_id: string | null;
  /** price_tier_id (uuid). NULL omits the *_price_tier scopes. */
  price_tier_id: string | null;
  /** grade_id (uuid; engine grade — Volume/Refined/Editorial per mig 443). */
  grade_id: string | null;
}

export interface ResolveGalleryPositionsResult {
  /** Ordered list (by position_index ASC after resolution). */
  positions: ResolvedGalleryPosition[];
  /** Free-text warnings for the audit trail. Never throws on missing table. */
  warnings: string[];
  /**
   * `true` when the underlying `gallery_positions` table is missing or
   * empty — callers can decide to fall back to legacy slot resolution.
   */
  is_empty: boolean;
}

// ─── Scope resolver order ──────────────────────────────────────────────────
// Lowest specificity → highest specificity (last wins per position_index).
//
// Each entry produces (scope_type, scope_ref_id, scope_ref_id_2,
// scope_ref_id_3) for an .eq() filter. NULL ref_id_2/3 must compare with
// .is('column', null) (not .eq(null)) to match Postgres NULL semantics in
// PostgREST.
interface ScopeFilter {
  scope_type: string;
  scope_ref_id: string;
  scope_ref_id_2: string | null;
  scope_ref_id_3: string | null;
}

const SCOPE_ORDER: Array<{
  scope_type: string;
  build: (a: ResolveGalleryPositionsArgs) => ScopeFilter | null;
}> = [
  {
    scope_type: 'project_type',
    build: (a) =>
      a.project_type_id
        ? {
            scope_type: 'project_type',
            scope_ref_id: a.project_type_id,
            scope_ref_id_2: null,
            scope_ref_id_3: null,
          }
        : null,
  },
  {
    scope_type: 'package_grade',
    build: (a) =>
      a.package_id && a.grade_id
        ? {
            scope_type: 'package_grade',
            scope_ref_id: a.package_id,
            scope_ref_id_2: a.grade_id,
            scope_ref_id_3: null,
          }
        : null,
  },
  {
    scope_type: 'package_x_price_tier',
    build: (a) =>
      a.package_id && a.price_tier_id
        ? {
            scope_type: 'package_x_price_tier',
            scope_ref_id: a.package_id,
            scope_ref_id_2: a.price_tier_id,
            scope_ref_id_3: null,
          }
        : null,
  },
  {
    scope_type: 'product',
    build: (a) =>
      a.product_id
        ? {
            scope_type: 'product',
            scope_ref_id: a.product_id,
            scope_ref_id_2: null,
            scope_ref_id_3: null,
          }
        : null,
  },
  {
    scope_type: 'product_x_price_tier',
    build: (a) =>
      a.product_id && a.price_tier_id
        ? {
            scope_type: 'product_x_price_tier',
            scope_ref_id: a.product_id,
            scope_ref_id_2: a.price_tier_id,
            scope_ref_id_3: null,
          }
        : null,
  },
  {
    scope_type: 'package_x_price_tier_x_project_type',
    build: (a) =>
      a.package_id && a.price_tier_id && a.project_type_id
        ? {
            scope_type: 'package_x_price_tier_x_project_type',
            scope_ref_id: a.package_id,
            scope_ref_id_2: a.price_tier_id,
            scope_ref_id_3: a.project_type_id,
          }
        : null,
  },
];

// Exported for tests.
export function buildScopeFilters(
  args: ResolveGalleryPositionsArgs,
): ScopeFilter[] {
  const out: ScopeFilter[] = [];
  for (const s of SCOPE_ORDER) {
    const f = s.build(args);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Pure merge function: takes scope rows in resolver-order (lowest to highest
 * specificity) and returns a Map<position_index, ResolvedGalleryPosition>
 * where last-write-wins per position_index.
 */
export function mergePositionsByScope(
  scopedRows: Array<{
    scope_type: string;
    scope_ref_id: string;
    rows: Array<Record<string, unknown>>;
  }>,
): Map<number, ResolvedGalleryPosition> {
  const merged = new Map<number, ResolvedGalleryPosition>();
  for (const scope of scopedRows) {
    for (const r of scope.rows) {
      const idx = Number(r.position_index ?? -1);
      if (!Number.isFinite(idx) || idx < 0) continue;
      merged.set(idx, normaliseRow(r, scope.scope_type, scope.scope_ref_id));
    }
  }
  return merged;
}

function normaliseRow(
  r: Record<string, unknown>,
  scope_type: string,
  scope_ref_id: string,
): ResolvedGalleryPosition {
  const phaseRaw = typeof r.phase === 'string' ? r.phase : 'optional';
  const phase: GalleryPositionPhase =
    phaseRaw === 'mandatory' || phaseRaw === 'conditional' || phaseRaw === 'optional'
      ? phaseRaw
      : 'optional';
  return {
    position_index: Number(r.position_index ?? 0),
    phase,
    room_type: stringOrNull(r.room_type),
    space_type: stringOrNull(r.space_type),
    zone_focus: stringOrNull(r.zone_focus),
    shot_scale: stringOrNull(r.shot_scale),
    perspective_compression: stringOrNull(r.perspective_compression),
    orientation: stringOrNull(r.orientation),
    lens_class: stringOrNull(r.lens_class),
    image_type: stringOrNull(r.image_type),
    composition_type: stringOrNull(r.composition_type),
    selection_mode:
      typeof r.selection_mode === 'string' && r.selection_mode.length > 0
        ? r.selection_mode
        : 'ai_decides',
    ai_backfill_on_gap: r.ai_backfill_on_gap !== false,
    notes: stringOrNull(r.notes),
    template_slot_id: stringOrNull(r.template_slot_id),
    resolved_from_scope_type: scope_type,
    resolved_from_scope_ref_id: scope_ref_id,
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * DB-backed resolver. Loads gallery_positions across all scope filters
 * derived from the round, merges last-wins per position_index, and returns
 * the ordered list.
 *
 * Tolerant of R1's mig 443 not existing yet — surfaces a warning + returns
 * an empty list so legacy slot resolution can take over.
 */
export async function resolveGalleryPositions(
  args: ResolveGalleryPositionsArgs,
): Promise<ResolveGalleryPositionsResult> {
  const warnings: string[] = [];
  const filters = buildScopeFilters(args);
  if (filters.length === 0) {
    return { positions: [], warnings: ['no scope filters could be derived'], is_empty: true };
  }

  const scopedRows: Array<{
    scope_type: string;
    scope_ref_id: string;
    rows: Array<Record<string, unknown>>;
  }> = [];
  for (const f of filters) {
    let q = args.admin
      .from('gallery_positions')
      .select(
        'position_index, phase, ' +
          'room_type, space_type, zone_focus, shot_scale, perspective_compression, ' +
          'orientation, lens_class, image_type, composition_type, ' +
          'selection_mode, ai_backfill_on_gap, notes, template_slot_id',
      )
      .eq('scope_type', f.scope_type)
      .eq('scope_ref_id', f.scope_ref_id);
    // PostgREST: `.is(col, null)` matches NULL; `.eq(col, value)` matches non-null.
    q = f.scope_ref_id_2 === null
      ? q.is('scope_ref_id_2', null)
      : q.eq('scope_ref_id_2', f.scope_ref_id_2);
    q = f.scope_ref_id_3 === null
      ? q.is('scope_ref_id_3', null)
      : q.eq('scope_ref_id_3', f.scope_ref_id_3);
    const { data, error } = await q.order('position_index', { ascending: true });
    if (error) {
      const msg = String(error.message ?? error);
      // Likely "relation does not exist" when R1's mig 443 hasn't run yet.
      if (msg.includes('does not exist') || msg.includes('PGRST205')) {
        warnings.push('gallery_positions table missing; falling back to legacy slot resolution');
        return { positions: [], warnings, is_empty: true };
      }
      warnings.push(`gallery_positions lookup failed for ${f.scope_type}=${f.scope_ref_id}: ${msg}`);
      continue;
    }
    scopedRows.push({
      scope_type: f.scope_type,
      scope_ref_id: f.scope_ref_id,
      rows: (data || []) as unknown as Array<Record<string, unknown>>,
    });
  }

  const merged = mergePositionsByScope(scopedRows);
  if (merged.size === 0) {
    return { positions: [], warnings, is_empty: true };
  }
  const positions = Array.from(merged.values()).sort(
    (a, b) => a.position_index - b.position_index,
  );
  return { positions, warnings, is_empty: false };
}

// ─── Prompt rendering helper ───────────────────────────────────────────────

/**
 * Render the resolved positions as a numbered constraint table for Stage 4's
 * user prompt. Each line shows the position_index, phase, and constraint
 * tuple — NULL constraints render as "any" so Gemini understands the wildcard
 * semantics.
 */
export function renderGalleryPositionsBlock(
  positions: ResolvedGalleryPosition[],
): string {
  if (positions.length === 0) return '';
  const lines: string[] = [];
  lines.push('── GALLERY POSITIONS (constraint tuples — fill 1 image per position) ──');
  lines.push(
    'Each position is a partial constraint over the round\'s images. Match images to ' +
      'positions by satisfying as many constraint axes as possible. NULL ("any") = wildcard, ' +
      'satisfied by any value. Phase semantics: ',
  );
  lines.push('  - mandatory   → MUST be filled if any image satisfies the constraints (else gap event).');
  lines.push('  - conditional → fill ONLY when an image clearly satisfies the constraints.');
  lines.push('  - optional    → fill ONLY when there is a strong, clear match.');
  lines.push('');
  for (const p of positions) {
    const axes: string[] = [];
    axes.push(`room_type=${p.room_type ?? 'any'}`);
    axes.push(`space_type=${p.space_type ?? 'any'}`);
    axes.push(`zone_focus=${p.zone_focus ?? 'any'}`);
    axes.push(`shot_scale=${p.shot_scale ?? 'any'}`);
    axes.push(`perspective_compression=${p.perspective_compression ?? 'any'}`);
    axes.push(`orientation=${p.orientation ?? 'any'}`);
    axes.push(`lens_class=${p.lens_class ?? 'any'}`);
    axes.push(`image_type=${p.image_type ?? 'any'}`);
    axes.push(`composition_type=${p.composition_type ?? 'any'}`);
    const tplBit = p.template_slot_id ? ` template=${p.template_slot_id}` : '';
    const backfill = p.ai_backfill_on_gap ? '' : ' ai_backfill_on_gap=false';
    const modeBit = p.selection_mode === 'curated' ? ' (curated)' : '';
    lines.push(
      `[${p.position_index}] ${p.phase}${modeBit}${tplBit}${backfill} :: ${axes.join(' ')}`,
    );
    if (p.notes) lines.push(`     note: ${p.notes}`);
  }
  return lines.join('\n');
}

export const RESOLVE_GALLERY_POSITIONS_VERSION = 'v1.1';

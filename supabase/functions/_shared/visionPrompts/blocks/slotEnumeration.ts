/**
 * slotEnumeration.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Renders the SHORTLISTING CONTEXT preamble (property/package/tier/totals) and
 * the SLOT REQUIREMENTS section (Phase 1 mandatory + Phase 2 conditional +
 * Phase 3 free-recommendation cap) from the active slot_definitions list.
 *
 * Wave 7 P1-6 (W7.7) updates:
 *   - `tier` opt renamed to `pricingTier` to disambiguate from engine_tier
 *     (S/P/A).
 *   - `describeCeiling()` retired — caller now supplies `packageDisplayName`
 *     directly (the package's actual DB name), so the prompt no longer
 *     reverse-engineers a label from the numeric ceiling.
 *   - `engineRoles` field added — surfaced in the SHORTLISTING CONTEXT block
 *     so the model knows which deliverable types are in scope.
 *
 * Wave 11.7.1 (W11.7.1 hygiene) addition:
 *   - `CANONICAL_SLOT_IDS` closed enum + `SLOT_ID_ALIASES` drift map +
 *     `normaliseSlotId()` helper. Stage 4 emits free-form slot_id strings
 *     that drift across regen runs (e.g. `exterior_rear` vs `exterior_rear_hero`,
 *     `living_hero` vs `living_dining_hero`). The downstream swimlane keys
 *     off slot_id, so dupes fragment the lane. We now (a) constrain the
 *     Gemini responseSchema with this enum, (b) normalise via the alias map
 *     at persist time, (c) drop unrecognised slot_ids with a warning rather
 *     than silently fragmenting.
 *
 * Bumped to v1.2 to reflect the canonical-enum addition.
 */

import type { Pass2SlotDefinition } from '../../pass2Prompt.ts';

// v1.4 (QC iter 3 P0 F-3C-003): extended CANONICAL_SLOT_IDS with the 32+
// W11.6.24 (mig 422) slot_definitions inserts so the Stage 4 tool schema
// enum and persist-time normaliseSlotId() accept the live DB vocabulary.
// Pre-fix Stage 4 would refuse to emit any of the new slots (schema
// validation failure) and persist would drop the row. Aliases that
// collided with DB-active slot_ids (`exterior_front_hero`, `open_plan_hero`,
// `garden_hero`) were promoted to canonical entries.
//
// v1.3 (W11.6.22): per-slot selection_mode rendering. ai_decides slots emit
// the legacy "exactly N image(s)" line; curated_positions slots enumerate one
// row per position with composition / zone / space / lighting / image-type /
// signal-emphasis hints + is_required + ai_backfill_on_gap flags. Stage 4 is
// instructed to emit `position_index` per slot_decision and to use
// `position_filled_via='ai_backfill'` when curation cannot be matched.
export const SLOT_ENUMERATION_BLOCK_VERSION = 'v1.4';

// ─── Canonical slot vocabulary (W11.7.1 hygiene) ────────────────────────────
//
// Closed set of slot_ids Stage 4 is allowed to emit. The schema (Gemini
// responseSchema enum) constrains the model directly; the persist layer
// double-checks via normaliseSlotId() and drops unrecognised ids.
//
// Ordered by phase for readability — Phase 1 lead heroes first, then Phase 2
// supporting, then Phase 3 detail/specials, plus a Phase-3 sentinel for
// free-recommendation rows.
export const CANONICAL_SLOT_IDS = [
  // Phase 1 — lead heroes (always filled when eligible)
  'exterior_facade_hero',
  'exterior_front_hero', // QC3 F-3C-003: live in DB (mig 422)
  'kitchen_hero',
  'living_hero',
  'open_plan_hero', // QC3 F-3C-003: live in DB (mig 422)
  'master_bedroom_hero',
  'alfresco_hero',

  // Phase 2 — supporting
  'exterior_rear',
  'kitchen_secondary',
  'dining_hero',
  'bedroom_secondary',
  'secondary_bedroom_hero', // QC3 F-3C-003: live in DB (mig 422)
  'bathroom_main',
  'ensuite_hero',
  'secondary_ensuite_hero', // QC3 F-3C-003 (mig 422)
  'entry_hero',
  'study_hero',
  'powder_room',
  'laundry_hero',
  'garage_hero',
  'pool_hero',
  'pool_day_hero', // QC3 F-3C-003 (mig 422)
  'pool_dusk_hero', // QC3 F-3C-003 (mig 422)
  'view_hero',

  // Phase 2 — supporting (W11.6.24 / mig 422 additions)
  'home_office_hero',
  'kids_bedroom_hero',
  'walk_in_robe_hero',
  'wine_cellar_hero',
  'gym_hero',
  'mudroom_hero',
  'theatre_hero',
  'study_laundry_powder',

  // Phase 3 — detail / archive / specials (legacy)
  'kitchen_detail',
  'bathroom_detail',
  'material_detail',
  'garden_detail',
  'garden_hero', // QC3 F-3C-003: live in DB (mig 422)
  'balcony_terrace',
  'games_room',
  'media_room',

  // Phase 3 — detail / outlook / overhead / cluster (W11.6.24 / mig 422 additions)
  'kitchen_appliance_cluster',
  'kitchen_island',
  'kitchen_gulley',
  'kitchen_pendant_detail',
  'bathroom_tile_detail',
  'period_feature_detail',
  'joinery_detail',
  'master_bed_window_outlook',
  'master_ensuite_freestanding_bath',
  'master_walk_in_robe_detail',
  'lounge_fireplace',
  'lounge_upstairs',
  'lounge_window',
  'dining_outlook',
  'dining_overhead',
  'garden_path',
  'view_from_balcony',

  // Drone (W11.6.24 / mig 422)
  'drone_aerial_nadir',
  'drone_aerial_oblique',

  // Phase 3 sentinel — Stage 4 free recommendations not tied to a specific slot.
  'ai_recommended',
] as const;

export type CanonicalSlotId = typeof CANONICAL_SLOT_IDS[number];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_SLOT_IDS);

/**
 * Drift map from observed Gemini variants → canonical slot_id. Common
 * patterns:
 *   - `_hero` suffix added/dropped inconsistently (e.g. master_bedroom vs
 *     master_bedroom_hero).
 *   - Compound room labels collapsed to a single slot (e.g. living_dining_hero
 *     → living_hero — dining is its own Phase 2 slot).
 *   - Synonyms (alfresco_outdoor_hero, outdoor_hero → alfresco_hero;
 *     exterior_front_hero → exterior_facade_hero).
 *
 * Keys MUST be lowercase snake_case. Values MUST be members of CANONICAL_SLOT_IDS.
 */
export const SLOT_ID_ALIASES: Readonly<Record<string, CanonicalSlotId>> = {
  // _hero suffix drift
  master_bedroom: 'master_bedroom_hero',
  exterior_facade: 'exterior_facade_hero',
  exterior_rear_hero: 'exterior_rear',
  kitchen: 'kitchen_hero',
  living: 'living_hero',
  dining: 'dining_hero',
  alfresco: 'alfresco_hero',
  ensuite: 'ensuite_hero',
  entry: 'entry_hero',
  study: 'study_hero',
  study_office: 'study_hero',
  view: 'view_hero',
  pool: 'pool_hero',
  laundry: 'laundry_hero',
  garage: 'garage_hero',
  bathroom: 'bathroom_main',

  // Compound-room collapse. NOTE: `open_plan_hero` is itself canonical
  // post-mig 422 (lives in DB), so it is no longer aliased to `living_hero`.
  living_dining_hero: 'living_hero',
  living_dining: 'living_hero',
  open_plan: 'open_plan_hero',
  kitchen_living_hero: 'kitchen_hero',
  kitchen_dining_hero: 'kitchen_hero',

  // Synonyms — exterior. NOTE: `exterior_front_hero` is itself canonical
  // post-mig 422 (lives in DB), so it is no longer aliased — see
  // CANONICAL_SLOT_IDS. The alias map preserves any aliases that resolve TO
  // `exterior_facade_hero` for replay parity with pre-W11.6.24 traffic.
  exterior_front: 'exterior_front_hero',
  facade_hero: 'exterior_facade_hero',
  facade: 'exterior_facade_hero',
  street_view_hero: 'exterior_facade_hero',
  exterior_back: 'exterior_rear',
  exterior_back_hero: 'exterior_rear',
  rear_hero: 'exterior_rear',
  backyard_hero: 'exterior_rear',
  backyard: 'exterior_rear',

  // Synonyms — alfresco / outdoor
  alfresco_outdoor_hero: 'alfresco_hero',
  outdoor_hero: 'alfresco_hero',
  outdoor: 'alfresco_hero',
  patio_hero: 'alfresco_hero',
  deck_hero: 'alfresco_hero',
  balcony_terrace_hero: 'balcony_terrace',
  balcony_hero: 'balcony_terrace',
  terrace_hero: 'balcony_terrace',

  // Synonyms — bedrooms / bathrooms
  bedroom_2: 'bedroom_secondary',
  bedroom_3: 'bedroom_secondary',
  bedroom_4: 'bedroom_secondary',
  secondary_bedroom: 'bedroom_secondary',
  guest_bedroom: 'bedroom_secondary',
  primary_bedroom: 'master_bedroom_hero',
  primary_bedroom_hero: 'master_bedroom_hero',
  main_bedroom: 'master_bedroom_hero',
  main_bedroom_hero: 'master_bedroom_hero',
  bathroom_hero: 'bathroom_main',
  main_bathroom: 'bathroom_main',
  main_bathroom_hero: 'bathroom_main',
  ensuite_main: 'ensuite_hero',

  // Synonyms — Phase 3. NOTE: `garden_hero` is itself canonical post-mig 422
  // (lives in DB), so it is no longer aliased to `garden_detail`.
  detail_hero: 'material_detail',
  material_hero: 'material_detail',
  landscape_detail: 'garden_detail',
  kitchen_detail_hero: 'kitchen_detail',
  bathroom_detail_hero: 'bathroom_detail',
  games_room_hero: 'games_room',
  media_room_hero: 'media_room',
  cinema_room: 'media_room',
  cinema_room_hero: 'media_room',
  rumpus_room: 'games_room',
  rumpus: 'games_room',

  // Free-recommendation sentinel
  ai_recommendation: 'ai_recommended',
  free_recommendation: 'ai_recommended',
  bonus: 'ai_recommended',
  bonus_recommendation: 'ai_recommended',
};

/**
 * Normalise a free-form slot_id through the alias map then validate against
 * the canonical enum. Returns the canonical form, or `null` when neither
 * the raw nor the aliased value is in the canonical set.
 *
 * Caller-side discipline: STRICT — drop the row when this returns null.
 */
export function normaliseSlotId(raw: unknown): CanonicalSlotId | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Direct canonical hit.
  if (CANONICAL_SET.has(trimmed)) return trimmed as CanonicalSlotId;
  // Aliased.
  const aliased = SLOT_ID_ALIASES[trimmed];
  if (aliased && CANONICAL_SET.has(aliased)) return aliased;
  return null;
}

/** Convenience predicate for tests / callers. */
export function isCanonicalSlotId(raw: unknown): raw is CanonicalSlotId {
  return typeof raw === 'string' && CANONICAL_SET.has(raw);
}

export interface SlotEnumerationBlockOpts {
  /** Resolved street/property address (falls back to "Unknown property"). */
  propertyAddress: string | null;
  /** Free-form package name from the round (e.g. "Gold Package"). */
  packageType: string;
  /** Caller-supplied display name for the prompt's ceiling line — Wave 7
   *  P1-6 replacement for the dropped describeCeiling() label. */
  packageDisplayName: string;
  /** Hard upper bound on shortlist size — sourced dynamically from the
   *  round.expected_count_target column under W7.7. */
  packageCeiling: number;
  /** 'standard' | 'premium' (informational; renamed from `tier` in W7.7). */
  pricingTier: string;
  /** Project's resolved engine roles. Wave 7 P1-6 — surfaced in the prompt
   *  so the model knows what deliverables are in play. */
  engineRoles: string[];
  /** Total compositions available, surfaced in the context block. */
  totalCompositions: number;
  /** Active slot definitions for this round. */
  slotDefinitions: Pass2SlotDefinition[];
}

export function slotEnumerationBlock(opts: SlotEnumerationBlockOpts): string {
  const {
    propertyAddress,
    packageType,
    packageDisplayName,
    packageCeiling,
    pricingTier,
    engineRoles,
    totalCompositions,
    slotDefinitions,
  } = opts;

  const slotRequirements = renderSlotRequirements(
    slotDefinitions,
    packageCeiling,
    packageDisplayName,
  );

  const enginesLabel = engineRoles.length > 0
    ? engineRoles.join(', ')
    : '(none — slot list will be limited to phase 3)';

  // W11.6.22 — when ANY slot is curated_positions, append the per-position
  // emission contract so the model knows to set position_index and
  // position_filled_via on slot_decisions[].
  const hasCurated = slotDefinitions.some(
    (s) => s.selection_mode === 'curated_positions',
  );
  const curatedFooter = hasCurated
    ? [
        '',
        'CURATED POSITION CONTRACT (W11.6.22):',
        'For slots marked CURATED above, emit ONE slot_decisions[] entry per position:',
        '  - Set `position_index` to the position number (1-based, matches the row).',
        '  - Set `position_filled_via` to "curated_match" when the winner satisfies the position\'s composition / zone / space / lighting / image_type criteria.',
        '  - Set `position_filled_via` to "ai_backfill" when no candidate matches AND the position allows backfill — pick your best AI-decided alternative for that role.',
        '  - When a position is REQUIRED and no candidate matches AND backfill is disabled, omit that position from slot_decisions[] (the engine will emit a coverage_gap_required_position event for the swimlane to surface).',
        'For ai_decides slots, leave position_index and position_filled_via UNSET (they default to null).',
      ].join('\n')
    : '';

  const lines = [
    'SHORTLISTING CONTEXT:',
    `Property: ${propertyAddress || 'Unknown property'}`,
    `Package: ${packageType}`,
    `Pricing tier: ${pricingTier}`,
    `Engine roles in scope: ${enginesLabel}`,
    `Total compositions available: ${totalCompositions}`,
    `Package ceiling: ${packageCeiling} images (${packageDisplayName} maximum)`,
    '',
    'SLOT REQUIREMENTS:',
    slotRequirements,
  ];
  if (curatedFooter) lines.push(curatedFooter);
  return lines.join('\n');
}

// ─── Internal helpers (private to this block) ────────────────────────────────

function renderSlotRequirements(
  slotDefs: Pass2SlotDefinition[],
  packageCeiling: number,
  packageDisplayName: string,
): string {
  const phase1 = slotDefs.filter((s) => s.phase === 1);
  const phase2 = slotDefs.filter((s) => s.phase === 2);

  const renderSlot = (s: Pass2SlotDefinition): string => {
    // W11.6.22b — when selection_mode='curated_positions' and curated_positions
    // is populated, emit one row per position with the curated criteria. The
    // model now KNOWS each position's expected composition / zone / space /
    // lighting / image_type / signal emphasis + is_required + ai_backfill flag.
    if (
      s.selection_mode === 'curated_positions' &&
      Array.isArray(s.curated_positions) &&
      s.curated_positions.length > 0
    ) {
      const positions = [...s.curated_positions].sort(
        (a, b) => (a.position_index ?? 0) - (b.position_index ?? 0),
      );
      const header = `  - ${s.slot_id} (${s.display_name}) — CURATED, ${positions.length} position${positions.length === 1 ? '' : 's'} to fill:`;
      const lines = positions.map((p) => {
        const parts: string[] = [];
        if (p.preferred_composition_type) parts.push(`composition: ${p.preferred_composition_type}`);
        if (p.preferred_zone_focus) parts.push(`zone: ${p.preferred_zone_focus}`);
        if (p.preferred_space_type) parts.push(`space: ${p.preferred_space_type}`);
        if (p.preferred_lighting_state) parts.push(`lighting: ${p.preferred_lighting_state}`);
        if (p.preferred_image_type) parts.push(`image_type: ${p.preferred_image_type}`);
        if (Array.isArray(p.preferred_signal_emphasis) && p.preferred_signal_emphasis.length > 0) {
          parts.push(`emphasise: ${p.preferred_signal_emphasis.join(', ')}`);
        }
        const flags: string[] = [];
        if (p.is_required) flags.push('REQUIRED');
        if (p.ai_backfill_on_gap === false) flags.push('no_ai_backfill');
        const flagSuffix = flags.length > 0 ? ` [${flags.join(' · ')}]` : '';
        const detailSuffix = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
        const label = p.display_label || `Position ${p.position_index}`;
        return `      - Position ${p.position_index} — ${label}${detailSuffix}${flagSuffix}`;
      });
      const notesLine = s.notes ? `\n      (${s.notes})` : '';
      return [header, ...lines].join('\n') + notesLine;
    }

    const minMax =
      s.min_images === s.max_images
        ? `exactly ${s.max_images}`
        : `${s.min_images}-${s.max_images}`;
    const eligible = s.eligible_room_types.join(' | ');
    const notes = s.notes ? ` — ${s.notes}` : '';
    return `  - ${s.slot_id} (${s.display_name}): ${minMax} image(s); eligible room_type(s): ${eligible}${notes}`;
  };

  const lines: string[] = [];

  lines.push('PHASE 1 — MANDATORY SLOTS (always filled; flag as unfilled_mandatory if no candidate exists):');
  if (phase1.length === 0) {
    lines.push('  (none defined — escalate to ops, this is unexpected)');
  } else {
    for (const s of phase1) lines.push(renderSlot(s));
  }
  lines.push('');

  lines.push('PHASE 2 — CONDITIONAL SLOTS (filled only if at least one matching room_type appears in classifications below):');
  if (phase2.length === 0) {
    lines.push('  (none defined)');
  } else {
    for (const s of phase2) lines.push(renderSlot(s));
  }
  lines.push('');

  // Phase 3 has no predefined slot_ids — engine free recommendations bounded
  // only by the package ceiling minus what was filled in phases 1 + 2.
  lines.push('PHASE 3 — FREE RECOMMENDATIONS (no predefined slot_ids):');
  lines.push('  After filling all eligible Phase 1 + Phase 2 slots, review every remaining unselected composition.');
  lines.push('  For each one, ask: does this image show something of genuine buyer value that is not already represented in the proposed shortlist?');
  lines.push('  Recommend additional images in ranked priority order (rank 1 = best). For each, provide a one-sentence justification stating what unique value it adds.');
  lines.push(
    `  Cap: total shortlist size (Phase 1 + Phase 2 + Phase 3) MUST NOT EXCEED ${packageCeiling} images (${packageDisplayName} maximum).`,
  );
  lines.push('  Do not recommend near-duplicates of already-selected images.');

  return lines.join('\n');
}

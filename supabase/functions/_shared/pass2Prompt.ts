/**
 * pass2Prompt.ts — pure Pass 2 shortlisting prompt builder.
 *
 * Constructs the single-call, full-universe-context shortlisting prompt for
 * Pass 2. Verbatim structure from spec §6 with Stream B SCORING ANCHORS injected
 * via streamBInjector.buildScoringReferenceBlock().
 *
 * Critical v2 architectural rules baked into this prompt (DO NOT REMOVE):
 *
 *   1. SINGLE SONNET CALL WITH FULL UNIVERSE CONTEXT (spec L4). Pass 2 is NOT
 *      concurrent. The model receives every Pass 1 classification as one
 *      packed text block and makes shortlisting decisions across the whole
 *      shoot at once. Without the full universe, the model cannot make
 *      relative selection decisions and grade-inflates every image.
 *
 *   2. THREE-PHASE ARCHITECTURE (spec L5, §6). Phase 1 = mandatory always-fill,
 *      Phase 2 = conditional fills (only when room confirmed in classifications),
 *      Phase 3 = AI free recommendations bounded by package ceiling. The prompt
 *      enumerates phase-1 + phase-2 slots from the slot_definitions table; phase
 *      3 is unbounded prose ("free choice up to ceiling").
 *
 *   3. TOP-3 ALTERNATIVES PER SLOT (spec L13). Every slot output includes a
 *      winner + 2 alternatives so the swimlane UI can offer tap-to-swap. The
 *      JSON schema explicitly demands `slot_alternatives: { slot_id: [r2, r3] }`.
 *
 *   4. NEAR-DUPLICATE CULLING SCOPE WITHIN-ROOM (spec L7). Two compositions
 *      are duplicates ONLY if same room_type AND angle delta < 15° AND key
 *      element overlap > 80%. Different rooms with same label (e.g. living_room
 *      ground vs living_secondary upstairs) are NOT duplicates.
 *
 *   5. BEDROOM SPLIT SCORING (spec §6). master_bedroom_hero = highest
 *      combined; bedroom_secondary = highest AESTHETIC. Two different
 *      selection criteria.
 *
 *   6. ENSUITE SECOND ANGLE (spec L19). ensuite_primary slot allows up to
 *      2 images IF angle delta > 30° (shower-side + vanity-side complementary).
 *
 *   7. ALFRESCO + EXTERIOR_LOOKING_IN ELIGIBILITY (spec L6). composition is
 *      eligible for exterior_rear slot (not just alfresco_hero) when this
 *      vantage applies. Pass 1 pre-computes this on the eligible_for_exterior_rear
 *      column.
 *
 *   8. STREAM B INJECTION (spec L8). Same anchors as Pass 1 — the shortlisting
 *      decision references Tier S/P/A names so the model has consistent scale.
 *
 * Single export: buildPass2Prompt(opts) → { system, userPrefix }.
 *   The caller does NOT pass an image — Pass 2 is text-only with summarised
 *   classifications. Caller dispatches via callClaudeVision with model=
 *   claude-sonnet-4-6, max_tokens=4000, temperature=0.
 */

import {
  buildScoringReferenceBlock,
  type StreamBAnchors,
} from './streamBInjector.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Pass2SlotDefinition {
  slot_id: string;
  display_name: string;
  phase: 1 | 2 | 3;
  eligible_room_types: string[];
  max_images: number;
  min_images: number;
  notes: string | null;
}

/**
 * One classification row, projected to the fields Pass 2 actually needs.
 * The orchestrator joins composition_classifications with composition_groups
 * and produces this shape.
 */
export interface Pass2ClassificationRow {
  /** delivery_reference_stem from composition_groups (or best_bracket_stem
   *  fallback) — this is the canonical filename the model emits in JSON. */
  stem: string;
  group_id: string;
  group_index: number;
  room_type: string | null;
  composition_type: string | null;
  vantage_point: string | null;
  technical_score: number | null;
  lighting_score: number | null;
  composition_score: number | null;
  aesthetic_score: number | null;
  combined_score: number | null;
  is_styled: boolean | null;
  indoor_outdoor_visible: boolean | null;
  is_drone: boolean | null;
  is_exterior: boolean | null;
  eligible_for_exterior_rear: boolean | null;
  clutter_severity: string | null;
  flag_for_retouching: boolean | null;
  analysis: string | null;
}

export interface Pass2PromptOptions {
  /** Resolved street/property address — surfaced in the SHORTLISTING CONTEXT
   *  block. Falls back to "Unknown property" if absent. */
  propertyAddress: string | null;
  /** 'Gold' | 'Day to Dusk' | 'Premium' | other text from shortlisting_rounds.package_type */
  packageType: string;
  /** 24 (Gold) | 31 (Day to Dusk) | 38 (Premium) — hard upper bound on shortlist size. */
  packageCeiling: number;
  /** 'standard' | 'premium' (mostly informational — Stream B handles the heavy lifting). */
  tier: 'standard' | 'premium' | string;
  /** Active slot definitions for this package_type (filtered by orchestrator). */
  slotDefinitions: Pass2SlotDefinition[];
  /** Stream B tier anchors loaded from streamBInjector. */
  streamBAnchors: StreamBAnchors;
  /** All Pass 1 classifications for the round (one per composition). */
  classifications: Pass2ClassificationRow[];
}

export interface Pass2Prompt {
  /** System message — sets the editor-grade-shortlister role. */
  system: string;
  /** User-message text (no image part) — full universe of classifications. */
  userPrefix: string;
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the shortlisting decision engine for a professional Sydney-based real estate media company. You receive the full set of classifications for an entire 60-image shoot and you produce the proposed shortlist in a single response.

You are NOT classifying individual images — that work is already done. You are making relative selection decisions with full knowledge of the entire shoot universe. This is exactly how a human editor works: view all the shots first, then select.

Your output is a coverage-checked, three-phase shortlist with top-3 alternatives per slot, near-duplicate culling within room clusters only, and a coverage notes paragraph. The Stream B scoring anchors define the score scale you are interpreting; do not re-score, just use the existing scores to make selection decisions.

You do not hallucinate slot fills. If no candidate exists for a mandatory slot, you mark it unfilled — never substitute an unrelated image.`;

// ─── Helper — compact one-line classification format (spec §6) ───────────────

/**
 * Format one classification as a single line per spec §6. Format:
 *
 *   [stem] | [room_type] | [comp_type] | [vantage_point] | C=N L=N T=N A=N avg=N | styled=B io=B | [analysis excerpt 80 chars]
 *
 * - Numbers rounded to one decimal, fall back to "?" when null.
 * - Booleans rendered T/F to keep lines short.
 * - Analysis excerpt is the first 80 chars; trailing whitespace collapsed.
 */
export function formatClassificationLine(c: Pass2ClassificationRow): string {
  const num = (v: number | null): string =>
    v == null ? '?' : (Math.round(v * 10) / 10).toString();
  const bool = (v: boolean | null): string => (v === true ? 'T' : v === false ? 'F' : '?');

  const stem = c.stem || `group_${c.group_index}`;
  const room = c.room_type || 'unknown';
  const comp = c.composition_type || 'unknown';
  const vp = c.vantage_point || 'neutral';
  const t = num(c.technical_score);
  const l = num(c.lighting_score);
  const cs = num(c.composition_score);
  const a = num(c.aesthetic_score);
  const avg = num(c.combined_score);

  // Trim + collapse whitespace + cap at 80 chars
  const analysis = (c.analysis || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  // Eligibility badges that materially affect routing — keep ultra-compact
  const badges: string[] = [];
  if (c.eligible_for_exterior_rear) badges.push('eligXR');
  if (c.flag_for_retouching) badges.push('retouch');
  if (c.clutter_severity && c.clutter_severity !== 'none') badges.push(`clutter=${c.clutter_severity}`);
  if (c.is_drone) badges.push('drone');
  const badgeStr = badges.length > 0 ? ` | ${badges.join(' ')}` : '';

  return (
    `${stem} | ${room} | ${comp} | ${vp} | C=${cs} L=${l} T=${t} A=${a} avg=${avg} | ` +
    `styled=${bool(c.is_styled)} io=${bool(c.indoor_outdoor_visible)}${badgeStr} | ${analysis}`
  );
}

// ─── Helper — render slot requirements section ───────────────────────────────

function renderSlotRequirements(
  slotDefs: Pass2SlotDefinition[],
  packageCeiling: number,
): string {
  const phase1 = slotDefs.filter((s) => s.phase === 1);
  const phase2 = slotDefs.filter((s) => s.phase === 2);

  const renderSlot = (s: Pass2SlotDefinition): string => {
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
    `  Cap: total shortlist size (Phase 1 + Phase 2 + Phase 3) MUST NOT EXCEED ${packageCeiling} images (${describeCeiling(packageCeiling)}).`,
  );
  lines.push('  Do not recommend near-duplicates of already-selected images.');

  return lines.join('\n');
}

function describeCeiling(ceiling: number): string {
  if (ceiling <= 24) return 'Gold maximum';
  if (ceiling <= 31) return 'Day to Dusk maximum';
  if (ceiling <= 38) return 'Premium maximum';
  return 'package maximum';
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildPass2Prompt(opts: Pass2PromptOptions): Pass2Prompt {
  const {
    propertyAddress,
    packageType,
    packageCeiling,
    tier,
    slotDefinitions,
    streamBAnchors,
    classifications,
  } = opts;

  const scoringReference = buildScoringReferenceBlock(streamBAnchors);
  const slotRequirements = renderSlotRequirements(slotDefinitions, packageCeiling);

  // ─── Build the all-classifications block (one line per composition) ──────
  // Sort by group_index so the model sees them in capture order — this is the
  // same order an editor scrolls through. Stable order also makes diffs across
  // re-runs human-readable.
  const sortedClass = [...classifications].sort((a, b) => a.group_index - b.group_index);
  const classBlockLines = sortedClass.map((c) => formatClassificationLine(c));

  const userPrefix = [
    // ─── SHORTLISTING CONTEXT ────────────────────────────────────────────────
    'SHORTLISTING CONTEXT:',
    `Property: ${propertyAddress || 'Unknown property'}`,
    `Package: ${packageType}`,
    `Tier: ${tier}`,
    `Total compositions available: ${classifications.length}`,
    `Package ceiling: ${packageCeiling} images (${describeCeiling(packageCeiling)})`,
    '',
    // ─── SLOT REQUIREMENTS ───────────────────────────────────────────────────
    'SLOT REQUIREMENTS:',
    slotRequirements,
    '',
    // ─── NEAR-DUPLICATE CULLING RULES (spec L7) ──────────────────────────────
    'NEAR-DUPLICATE CULLING RULES (within-room only — spec L7):',
    'Two compositions are near-duplicates ONLY IF ALL THREE are true:',
    '  1. Same physical room (same room_type label).',
    '  2. Same approximate camera position (angle delta < 15°).',
    '  3. Key element overlap > 80%.',
    'Different rooms with the same label are NOT duplicates. In particular:',
    '  - living_room (ground floor) and living_secondary (upstairs lounge) are DIFFERENT rooms — never cull as duplicates.',
    '  - ensuite_primary shower-side and ensuite_primary vanity-side are DIFFERENT angles when delta > 30° — keep both.',
    '  - Two exterior_front shots from substantially different positions are not duplicates.',
    '',
    // ─── BEDROOM SELECTION RULES (spec §6) ───────────────────────────────────
    'BEDROOM SELECTION RULES:',
    '  master_bedroom_hero: pick the bedroom with the HIGHEST COMBINED score (avg of T+L+C+A).',
    '  bedroom_secondary:   pick by HIGHEST AESTHETIC score — NOT combined, NOT size — aesthetic only.',
    '  All else equal, styled (is_styled=T) beats unstyled (is_styled=F).',
    '',
    // ─── BATHROOM/ENSUITE RULES (spec L19) ───────────────────────────────────
    'BATHROOM / ENSUITE RULES:',
    '  ensuite_hero may include up to 2 images IF the two compositions show genuinely distinct angles (vantage difference, primary feature difference, or angle delta > 30°). A shower-side angle and a vanity-side angle communicate different features of the same room and are complementary — both count.',
    '  bathroom_main is a separate slot for a bathroom distinct from any ensuite.',
    '',
    // ─── ALFRESCO + EXTERIOR_RAR ELIGIBILITY (spec L6) ───────────────────────
    'ALFRESCO + EXTERIOR_REAR ELIGIBILITY (spec L6):',
    '  When room_type=alfresco AND vantage_point=exterior_looking_in (camera outside the structure looking back at the building), the composition is eligible for the exterior_rear slot, NOT just alfresco_hero. The classification line shows "eligXR" for these. Use them for exterior_rear when no purpose-shot exterior_rear candidate exists.',
    '',
    // ─── Stream B anchors (spec L8) ──────────────────────────────────────────
    scoringReference,
    // ─── ALL CLASSIFICATIONS (full shoot, one line each) ─────────────────────
    `ALL CLASSIFICATIONS — FULL SHOOT (${sortedClass.length} compositions, in capture order):`,
    'Format: [stem] | [room_type] | [comp_type] | [vantage_point] | C=composition L=lighting T=technical A=aesthetic avg=combined | styled=T/F io=indoor_outdoor | [optional badges] | [analysis excerpt]',
    '',
    ...classBlockLines,
    '',
    // ─── INSTRUCTIONS ────────────────────────────────────────────────────────
    'INSTRUCTIONS:',
    '1. Fill every Phase 1 mandatory slot first. If no candidate exists for a mandatory slot, list it in unfilled_slots — DO NOT pick an unrelated image.',
    '2. Fill Phase 2 conditional slots ONLY for room types confirmed in the classifications above.',
    '3. Fill Phase 3 free recommendations up to the ceiling, ranked by genuine value-add. Each recommendation needs a one-sentence justification of what unique value it adds.',
    '4. For every slot you fill, identify the top 3 candidates (winner = slot_assignments, ranks 2 + 3 = slot_alternatives). The winner must NOT also appear in slot_alternatives for the same slot.',
    '5. Identify near-duplicates (per the within-room rules above) and list their stems in rejected_near_duplicates. A stem CANNOT appear in both shortlist and rejected_near_duplicates — shortlist takes precedence.',
    '6. Write a coverage_notes paragraph (3-6 sentences) summarising shoot quality, any gaps, and notable strengths/weaknesses. This appears in the human review UI.',
    '',
    // ─── JSON output schema ──────────────────────────────────────────────────
    'Return ONLY valid JSON, no Markdown fences, no commentary, no prose before or after:',
    '{',
    '  "shortlist": ["stem1", "stem2", ...],   // every stem chosen across all 3 phases',
    '  "slot_assignments": {',
    '    "<slot_id>": "stem"                    // single-image slot',
    '    "<slot_id>": ["stem", "stem"]          // multi-image slot (e.g. ensuite_hero with 2 angles)',
    '  },',
    '  "slot_alternatives": {',
    '    "<slot_id>": ["rank2_stem", "rank3_stem"]   // next 2 best candidates per slot',
    '  },',
    '  "phase3_recommendations": [',
    '    { "file": "stem", "rank": 1, "justification": "what unique value this adds" }',
    '  ],',
    '  "unfilled_slots": ["<slot_id>", ...],          // slots with no suitable candidate',
    '  "rejected_near_duplicates": ["stem", ...],      // culled per within-room rules above',
    '  "coverage_notes": "Full paragraph summarising shoot quality and gaps."',
    '}',
    '',
    'Output requirement: respond with the JSON object only. Use the exact stems shown in the classification lines above — do not invent filenames. Stems are case-sensitive.',
  ].join('\n');

  return {
    system: SYSTEM_PROMPT,
    userPrefix,
  };
}

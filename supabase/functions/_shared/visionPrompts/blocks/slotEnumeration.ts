/**
 * slotEnumeration.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Renders the SHORTLISTING CONTEXT preamble (property/package/tier/totals) and
 * the SLOT REQUIREMENTS section (Phase 1 mandatory + Phase 2 conditional +
 * Phase 3 free-recommendation cap) from the active slot_definitions list.
 *
 * Byte-stable lift from `pass2Prompt.ts` userPrefix lines 261-271 (context) +
 * the inlined `renderSlotRequirements()` helper.
 */

import type { Pass2SlotDefinition } from '../../pass2Prompt.ts';

export const SLOT_ENUMERATION_BLOCK_VERSION = 'v1.0';

export interface SlotEnumerationBlockOpts {
  /** Resolved street/property address (falls back to "Unknown property"). */
  propertyAddress: string | null;
  /** e.g. 'Gold' | 'Day to Dusk' | 'Premium' or any free text. */
  packageType: string;
  /** Hard upper bound on shortlist size — Gold=24 | DTD=31 | Premium=38 typically. */
  packageCeiling: number;
  /** 'standard' | 'premium' (informational). */
  tier: string;
  /** Total compositions available, surfaced in the context block. */
  totalCompositions: number;
  /** Active slot definitions for this package_type. */
  slotDefinitions: Pass2SlotDefinition[];
}

export function slotEnumerationBlock(opts: SlotEnumerationBlockOpts): string {
  const {
    propertyAddress,
    packageType,
    packageCeiling,
    tier,
    totalCompositions,
    slotDefinitions,
  } = opts;

  const slotRequirements = renderSlotRequirements(slotDefinitions, packageCeiling);

  return [
    'SHORTLISTING CONTEXT:',
    `Property: ${propertyAddress || 'Unknown property'}`,
    `Package: ${packageType}`,
    `Tier: ${tier}`,
    `Total compositions available: ${totalCompositions}`,
    `Package ceiling: ${packageCeiling} images (${describeCeiling(packageCeiling)})`,
    '',
    'SLOT REQUIREMENTS:',
    slotRequirements,
  ].join('\n');
}

// ─── Internal helpers (private to this block) ────────────────────────────────

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

export function describeCeiling(ceiling: number): string {
  if (ceiling <= 24) return 'Gold maximum';
  if (ceiling <= 31) return 'Day to Dusk maximum';
  if (ceiling <= 38) return 'Premium maximum';
  return 'package maximum';
}

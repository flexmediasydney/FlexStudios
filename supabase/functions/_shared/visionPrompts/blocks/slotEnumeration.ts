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
 * Bumped to v1.1 to reflect the new field surface.
 */

import type { Pass2SlotDefinition } from '../../pass2Prompt.ts';

export const SLOT_ENUMERATION_BLOCK_VERSION = 'v1.1';

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

  return [
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
  ].join('\n');
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
